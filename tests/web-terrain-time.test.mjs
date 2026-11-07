// The time machine's terrain layer: undoing ledger rows newer than the playhead against the voxels the
// page holds. Everything here is decided by the direction of an action and its time, so the tests are
// small made-up worlds plus the coordinate arithmetic, and one pass over the real overworld pack.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { withAccessors } from '../web/js/payload.js';
import {
  applyEdits, editsForCell, firstAfter, histStamp, rowsAfterCount, rowsByCell, stateIdsByName,
} from '../web/js/ledger-terrain.mjs';
import { decodeTimeline, tlPackCoord, tlX, tlY, tlZ } from '../shared/ledger-pack.mjs';
import { sectionIndex, voxelId } from '../web/js/lookup.js';
import { openChunk } from '../web/js/payload.js';
import { buildStateIds, decodeChunk, packChunk } from '../server/chunk-payload.mjs';
import { RegionFile } from '../tools/region.mjs';
import { readNbt } from '../tools/nbt.mjs';
import zlib from 'node:zlib';
import { readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { fakeLog } from './fake-ledger.mjs';

const T = (s) => 1717174690000 + s * 1000;
const AIR = 1, STONE = 2, DIRT = 3;
const NAMES = new Map([['minecraft:air', AIR], ['minecraft:stone', STONE], ['minecraft:dirt', DIRT]]);
const idFor = (n) => NAMES.get(n) ?? 0;

// A timeline built the way the bake builds one: rows in time order, with a name table.
// `tl.sec` counts seconds since the pack's own time base, which is its oldest row. The playhead the
// page passes is in the same base-relative units, so the fixtures speak wall offsets and this converts.
const timeline = (rows) => {
  const L = fakeLog(rows);
  const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  return { tl, P, ph: (s) => Math.floor(T(s) / 1000) - tl.timeBaseSec };
};

// Chunk-shaped the way payload.js hands one over: a palette of global state ids, and sparse sections
// that are either uniform (`single`, a 1-based palette slot) or a full 4,096-entry slot array. A
// section's `y` is a SECTION index (block y / 16), which is what the payload carries and what
// `sectionAt(blockY)` divides by sixteen to find.
const chunkOf = (cells) => {
  const palette = [AIR, STONE, DIRT];
  const sections = cells.map(([y, fill]) => (fill instanceof Uint16Array
    ? { y, single: 0, vox: fill }
    : { y, single: palette.indexOf(idFor(fill)) + 1, vox: null }));
  return withAccessors({
    cx: 0, cz: 0, yMin: 0, yCount: 5, palette, sections, height: null, heightMotion: null,
    blockEntities: null, unknownStates: 0, digest: 999, classicSections: false,
  });
};
const at = (ch, x, y, z) => ch.stateAt(x, y, z);

test('rows group by chunk and stay in time order', () => {
  const { tl } = timeline([
    [1, 0, 64, 0, 2, 1, T(30), 'minecraft:stone', ''],
    [1, 16, 64, 0, 2, 1, T(10), 'minecraft:dirt', ''],
    [1, 0, 64, 1, 3, 1, T(20), '', 'minecraft:stone'],
    [1, 0, 64, 2, 2, 1, T(40), 'minecraft:stone', ''],
  ]);
  assert.equal(tl.timeBaseSec, Math.floor(T(10) / 1000), 'the base is the oldest row');
  const order = Int32Array.from([0, 1, 2, 3]);
  const by = rowsByCell(tl, order);
  assert.equal(by.size, 2, 'two chunk cells');
  for (const rows of by.values()) {
    for (let i = 1; i < rows.length; i++) {
      assert.ok(tl.sec[rows[i]] >= tl.sec[rows[i - 1]], 'a cell row list is still sorted');
    }
  }
});

test('the playhead boundary is strict: a row AT the playhead is present, not undone', () => {
  const { tl, ph } = timeline([[1, 0, 64, 0, 2, 1, T(100), 'minecraft:stone', '']]);
  const rows = Int32Array.from([0]);
  assert.equal(firstAfter(tl, rows, ph(100)), 1, 'a row at the playhead is not newer than it');
  assert.equal(firstAfter(tl, rows, ph(99)), 0, 'one second earlier it is');
  assert.equal(rowsAfterCount(tl, rows, ph(100)), 0);
  assert.equal(rowsAfterCount(tl, rows, ph(50)), 1);
  assert.equal(histStamp(tl, rows, ph(100)), '', 'no newer rows means no history, so the mesh key is unchanged');
  // The stamp is a COUNT, not the playhead. `h<sec>x1` would re-key every touched chunk on every playhead
  // move even when the same row is the one being undone, which is the whole cost of a scrub.
  assert.equal(histStamp(tl, rows, ph(50)), 'x1');
});

test('a block broken after the playhead comes back, with the name the log recorded', () => {
  const { tl, ph } = timeline([[1, 2, 64, 3, 3, 1, T(500), 'minecraft:air', 'minecraft:stone']]);
  const ch = chunkOf([[4, 'minecraft:air']]);
  const got = editsForCell(tl, Int32Array.from([0]), ph(400), idFor);
  assert.equal(got.edits.length, 2);
  assert.equal(got.edits[1], STONE, 'the restored value is the broken block, not the air left behind');
  assert.equal(got.unknown, 0);
  const out = applyEdits(ch, got.edits, { withAccessors, airId: AIR });
  assert.equal(out.stateAt(2, 64, 3), STONE, 'the patched chunk shows the block');
  assert.equal(out.stateAt(2, 65, 3), AIR, 'and its neighbour is untouched');
  assert.equal(at(ch, 2, 64, 3), AIR, 'the original chunk the store holds is never written');
  assert.equal(out.digest !== ch.digest, true, 'a patched chunk is not the same payload');
});

test('undo is newest-first, so the surviving value is what stood at the playhead', () => {
  // Present: air. Log: placed dirt at 20, broke it at 30. Playhead 10 -> the block was not there yet.
  const { tl, ph } = timeline([
    [1, 1, 64, 1, 2, 1, T(20), 'minecraft:dirt', ''],
    [1, 1, 64, 1, 3, 1, T(30), '', 'minecraft:dirt'],
  ]);
  const got = editsForCell(tl, Int32Array.from([0, 1]), ph(10), idFor);
  const map = new Map();
  for (let i = 0; i < got.edits.length; i += 2) map.set(got.edits[i], got.edits[i + 1]);
  assert.equal(map.size, 1, 'one voxel, one answer, however many times it was touched');
  assert.equal(map.get(tlPackCoord(1, 64, 1)), 0, 'as of second 10 it had not been placed');

  // Same two rows, playhead between them: the block was standing, and the break is what to undo.
  const got2 = editsForCell(tl, Int32Array.from([0, 1]), ph(25), idFor);
  const map2 = new Map();
  for (let i = 0; i < got2.edits.length; i += 2) map2.set(got2.edits[i], got2.edits[i + 1]);
  assert.equal(map2.get(tlPackCoord(1, 64, 1)), DIRT, 'as of second 25 the dirt was standing');
});

test('a block placed after the playhead is taken away', () => {
  const { tl, ph } = timeline([[1, 4, 70, 4, 2, 1, T(200), 'minecraft:stone', '']]);
  const vox = new Uint16Array(4096).fill(1);      // palette slot 1 = STONE everywhere
  const ch = chunkOf([[4, vox]]);                  // block y 64..79, so y 70 lives here
  assert.equal(ch.stateAt(4, 70, 4), STONE);
  const got = editsForCell(tl, Int32Array.from([0]), ph(100), idFor);
  assert.deepEqual([...got.edits], [tlPackCoord(4, 70, 4), 0]);
  const out = applyEdits(ch, got.edits, { withAccessors, airId: AIR });
  assert.equal(out.stateAt(4, 70, 4), AIR, 'removed');
  assert.equal(out.stateAt(5, 70, 4), STONE, 'and only it');
  assert.equal(out.patchedCleared, 1);
});

test('a uniform section expands, and a section the payload omitted is invented as air', () => {
  const { tl, ph } = timeline([
    [1, 0, 64, 0, 3, 1, T(50), '', 'minecraft:stone'],      // in a `single` section
    [1, 0, 80, 0, 3, 1, T(50), '', 'minecraft:dirt'],       // in a section the payload never wrote
  ]);
  const ch = chunkOf([[4, 'minecraft:stone']]);             // no section at block y 80 (index 5) at all
  assert.equal(ch.sectionAt(80), null);
  const got = editsForCell(tl, Int32Array.from([0, 1]), ph(1), idFor);
  const out = applyEdits(ch, got.edits, { withAccessors, airId: AIR });
  assert.equal(out.stateAt(0, 64, 0), STONE);
  assert.equal(out.stateAt(0, 80, 0), DIRT, 'restored into a section that did not exist');
  assert.equal(out.stateAt(1, 80, 1), AIR, 'the rest of that invented section reads as air, not palette slot 0');
  assert.equal(out.sectionAt(80) !== undefined, true);
});

test('names the renderer has no state for change nothing, and other actions are left alone', () => {
  const { tl, ph } = timeline([
    [1, 0, 64, 0, 3, 1, T(50), '', 'minecraft:zombie'],     // a kill logged as a break
    [1, 1, 64, 0, 4, 1, T(50), 'minecraft:chest', ''],      // a container action
    [1, 2, 64, 0, 1, 1, T(50), 'minecraft:air', ''],        // an action class with no block meaning
  ]);
  const ch = chunkOf([[4, 'minecraft:air']]);
  const got = editsForCell(tl, Int32Array.from([0, 1, 2]), ph(1), idFor);
  assert.equal(got.edits.length, 0, 'nothing is written for a zombie or a chest');
  assert.equal(got.unknown, 1, 'and that is counted, not silent');
  assert.equal(got.otherRows, 2);
  const out = applyEdits(ch, got.edits, { withAccessors, airId: AIR });
  assert.equal(out.stateAt(0, 64, 0), AIR);
});

test('a row limit keeps a loud chunk bounded, and says it was bounded', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([1, i % 16, 64, (i * 3) % 16, 3, 1, T(100 + i), '', 'minecraft:stone']);
  const { tl, ph } = timeline(rows);
  const all = Int32Array.from(Array.from({ length: 40 }, (_, i) => i));
  const got = editsForCell(tl, all, ph(99), idFor, 10);
  assert.equal(got.edits.length / 2, 10);
  assert.equal(got.truncated, 30);
  assert.ok(got.breakRows <= 10);
});

test('names pick the plainest form of a block, and read either key spelling', () => {
  const states = [
    { k: 'minecraft:air' },
    { k: 'minecraft:stone' },
    { k: 'minecraft:deepslate|axis=z' },
    { k: 'minecraft:deepslate|axis=y' },
    { key: 'oak_stairs|facing=north|half=top' },
    { key: 'oak_stairs' },
  ];
  const ids = stateIdsByName(states);
  assert.equal(ids.get('minecraft:stone'), 2, 'global state ids are 1-based, like the payload');
  assert.equal(ids.get('minecraft:deepslate'), 3, 'fewest properties wins, lowest index breaks the tie');
  assert.equal(ids.get('oak_stairs'), 6);
  assert.equal(ids.get('minecraft:zombie'), undefined, 'the log names things that are not blocks');
});

// ---- the real overworld pack ---------------------------------------------------------------------
const packPath = 'build/ledger/region.ledpack';
if (existsSync(packPath)) {
  test('over the real overworld, undoing the loudest chunk moves real voxels', () => {
    const raw = readFileSync(packPath);
    const P = readPack(raw);
    const tl = decodeTimeline(raw.subarray(P.tlBytes[0], P.tlBytes[1]));
    // The loudest chunk in the log. Its rows and the undo count must agree at both ends of time.
    let loudest = 0, best = -1;
    for (let i = 0; i < P.cellCount; i++) {
      const c = P.cell(i);
      if (c.total > best) { best = c.total; loudest = i; }
    }
    const cell = P.cell(loudest);
    const rows = [];
    for (let i = 0; i < tl.count; i++) if (tl.cell[i] === loudest) rows.push(i);
    assert.equal(rows.length, best, 'the timeline carries every row the cell table counts');
    const atEnd = rowsAfterCount(tl, Int32Array.from(rows), tl.spanSec);
    assert.equal(atEnd, 0, 'at the last logged second there is nothing to undo');
    const atStart = rowsAfterCount(tl, Int32Array.from(rows), 0);
    assert.equal(atStart, rows.length, 'before the first second, every row is newer');
    // Undo everything: names resolve to real blocks, so a large share of the chunk's voxels move.
    const got = editsForCell(tl, Int32Array.from(rows), 0, (n) => {
      const ids = stateIdsByName(JSON.parse(readFileSync('build/assets/atlas.json', 'utf8')).states);
      return ids.get(n) ?? 0;
    });
    assert.ok(got.breakRows > 100, 'the loudest chunk logged real breaks');
    assert.ok(got.edits.length / 2 > 100, 'and the undo puts hundreds of voxels back');
    assert.ok(got.unknown / (got.breakRows + got.placeRows) < 0.05,
      'a few rows name entities or unmodelled mods; most name blocks the renderer can draw');
  });
}

// The renderer's side of the contract (M12b.4 part 2). The page does not send patched chunks to its mesh
// workers - it sends the edits, and the worker applies them to chunks it decoded itself. That only works
// if the plain postMessage shape patches identically to the decoded one, and if the key the page stamps
// a mesh with changes exactly when the undo set changes.
test('the mesh key counts the suffix, so a scrub re-keys only the chunks a crossed row belongs to', () => {
  const { tl, ph } = timeline([
    [1, 0, 64, 0, 2, 1, T(10), 'minecraft:stone', ''],
    [1, 1, 64, 0, 3, 1, T(20), '', 'minecraft:stone'],
    [1, 32, 64, 0, 2, 1, T(30), 'minecraft:dirt', ''],      // a different chunk cell
  ]);
  const by = rowsByCell(tl, Int32Array.from([0, 1, 2]));
  const cells = [...by.keys()];
  const a = by.get(cells[0]), b = by.get(cells[1]);
  // Both playheads sit between the first two rows of cell A: the same two rows are newer, so the same
  // two rows get undone, so the mesh parked under either key is still correct.
  assert.equal(histStamp(tl, a, ph(11)), histStamp(tl, a, ph(19)), 'a move that crosses no row keeps the key');
  assert.notEqual(histStamp(tl, a, ph(11)), histStamp(tl, a, ph(25)), 'crossing one row changes it');
  assert.equal(histStamp(tl, b, ph(11)), histStamp(tl, b, ph(19)));
  assert.notEqual(histStamp(tl, b, ph(11)), histStamp(tl, b, ph(35)));
  // The other half of the economy: a chunk the log never touched stamps '', so its key - and its parked
  // triangles - survive the whole scrub.
  assert.equal(histStamp(tl, null, ph(0)), '', 'an untouched chunk has no history at all');
  assert.equal(histStamp(tl, Int32Array.from([]), ph(0)), '');
});

test('the plain chunk a worker holds patches to exactly the voxels the page patched', () => {
  const { tl, ph } = timeline([
    [1, 2, 64, 3, 3, 1, T(500), 'minecraft:air', 'minecraft:stone'],   // break: stone comes back
    [1, 2, 70, 3, 2, 1, T(600), 'minecraft:dirt', ''],                 // place: dirt goes away
    [1, 5, 80, 9, 2, 1, T(700), 'minecraft:stone', ''],                // place in an omitted section
  ]);
  const got = editsForCell(tl, Int32Array.from([0, 1, 2]), ph(400), idFor);
  assert.equal(got.edits.length / 2, 3);

  const decoded = chunkOf([[4, 'minecraft:air'], [5, 'minecraft:dirt']]);
  const here = applyEdits(decoded, got.edits, { withAccessors, airId: AIR });
  // What postMessage can actually send: no closures, the payload fields only - web/js/main.js plainChunk.
  const plain = {
    cx: 0, cz: 0, yMin: 0, yCount: 5, palette: decoded.palette, height: decoded.height,
    sections: decoded.sections.map((s) => ({
      y: s.y, single: s.single, vox: s.vox, sky: s.sky, blk: s.blk, skyArr: s.skyArr, blkArr: s.blkArr,
    })),
  };
  const before = plain.sections.map((s) => s.vox && Uint16Array.from(s.vox));
  const there = applyEdits(plain, got.edits, { withAccessors, airId: AIR });
  assert.deepEqual(plain.sections.map((s) => s.vox && Uint16Array.from(s.vox)), before,
    'the worker path must not write into the chunk it was handed either');

  // And it reads voxels through sectionIndex/voxelId, not the accessors, so both halves get checked.
  const secOf = sectionIndex(there);
  for (let i = 0; i < got.edits.length; i += 2) {
    const c = got.edits[i], want = got.edits[i + 1] === 0 ? AIR : got.edits[i + 1];
    const x = tlX(c), y = tlY(c), z = tlZ(c);
    assert.equal(there.stateAt(x, y, z), want, `page path wrote the wrong block at ${x},${y},${z}`);
    assert.equal(voxelId(there, secOf, x, y, z), want, 'worker path disagrees with the page path');
    assert.equal(here.stateAt(x, y, z), there.stateAt(x, y, z), 'decoded input and plain input disagree');
  }
  assert.equal(here.palette.length, there.palette.length, 'both grew their palette the same way');
  for (let y = 64; y < 96; y += 8) {
    for (let z = 0; z < 16; z += 5) for (let x = 0; x < 16; x += 7) {
      assert.equal(here.stateAt(x, y, z), there.stateAt(x, y, z), `untouched voxel ${x},${y},${z} diverged`);
    }
  }
});

// The fixtures above hand applyEdits a plain Array palette. The renderer hands it a Uint16Array VIEW into
// the payload buffer, which has no `push` - and the first browser run of the terrain time machine died in
// the mesh worker for exactly that reason. So the real bytes get patched here.
const realSave = 'DarkRPG/world/region/r.-1.-1.mca';
if (existsSync(realSave) && existsSync(packPath)) {
  test('a real payload chunk - typed palette, sections as views into the frame - patches in place', () => {
    // The loudest chunk in the log: cx -3, cz -8, which lives in region r.-1.-1 at local 29,24.
    const rgn = new RegionFile(realSave);
    const raw = rgn.readChunkNbtBytes(29, 24);
    rgn.close();
    assert.ok(raw, 'the loudest logged chunk has to be in that region file');
    const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8')).states;
    const stateIds = buildStateIds(atlas.map((s) => s.k));
    const payload = packChunk(decodeChunk(readNbt(zlib.inflateSync(raw)).value, stateIds));
    const ch = openChunk(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    assert.ok(ch.palette instanceof Uint16Array, 'the real palette is a typed array view, not an Array');
    const bufs = new Set(ch.sections.filter((s) => s.vox).map((s) => s.vox.buffer));
    assert.ok(ch.sections.some((s) => s.vox) && bufs.size <= 1,
      'the voxel arrays are views into one frame buffer, which is why a patch has to copy them');

    const raw2 = readFileSync(packPath);
    const P = readPack(raw2);
    const tl = decodeTimeline(raw2.subarray(P.tlBytes[0], P.tlBytes[1]));
    let cell = -1;
    for (let i = 0; i < P.cellCount; i++) {
      const c = P.cell(i);
      if (c.cx === -3 && c.cz === -8) { cell = i; break; }
    }
    assert.ok(cell >= 0, 'the chunk is in the cell table');
    const rows = [];
    for (let i = 0; i < tl.count; i++) if (tl.cell[i] === cell) rows.push(i);
    const ids = stateIdsByName(atlas);
    const airId = (atlas.findIndex((s) => s.k === 'minecraft:air') ?? -1) + 1;
    assert.ok(airId > 0, 'the atlas holds air, so an undo can write real air');
    const got = editsForCell(tl, Int32Array.from(rows), 0, (n) => ids.get(n) ?? 0, 1200);
    assert.ok(got.edits.length / 2 > 100, 'undoing this chunk\'s whole history moves a lot of voxels');

    const sample = [];
    for (let y = 60; y < 90; y += 3) for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
      sample.push([x, y, z, ch.stateAt(x, y, z)]);
    }
    const patched = applyEdits(ch, got.edits, { withAccessors, airId });
    const secOf = sectionIndex(patched);
    let moved = 0, agree = 0;
    for (let i = 0; i < got.edits.length; i += 2) {
      const c = got.edits[i], want = got.edits[i + 1] === 0 ? airId : got.edits[i + 1];
      const v = patched.stateAt(tlX(c), tlY(c), tlZ(c));
      if (v !== 0 && v !== undefined) agree++;
      if (ch.stateAt(tlX(c), tlY(c), tlZ(c)) !== v) moved++;
      assert.equal(voxelId(patched, secOf, tlX(c), tlY(c), tlZ(c)), v, 'worker read disagrees with page read');
    }
    assert.ok(moved > 100, 'the patch really changed the voxels the mesh will read');
    assert.equal(agree, got.edits.length / 2, 'every edit landed on a block id');
    for (const [x, y, z, was] of sample) {
      assert.equal(ch.stateAt(x, y, z), was, 'the payload the store holds was written into');
    }
    assert.notEqual(patched.digest, ch.digest, 'a different world has a different fingerprint');
  });
}
