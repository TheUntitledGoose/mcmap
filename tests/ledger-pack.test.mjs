// The pack is a writer/reader pair over a binary layout, and the point query depends on the chunk index
// being sorted and the row slices being in time order. The timeline depends on all rows across all
// chunks being in time order together, which is a stronger claim and a separate test. All of it is
// checked here on a made-up log, and then against the real packs when they exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { LEDPACK_MAGIC, LEDPACK_VERSION, NCLASS, TL_HEADER, TL_NO_PLAYER, TL_REC, decodeTimeline, readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { readLedger } from '../shared/ledger-format.mjs';
import { fakeLog } from './fake-ledger.mjs';

// The log shape this file needs is the shared fake (tests/fake-ledger.mjs): the real reader's accessor
// surface plus interned object ids, which is what the timeline's name column resolves through.

const T = (s) => 1717174690000 + s * 1000;

test('cells count per action, mask the players, and cover the time span', () => {
  const L = fakeLog([
    [1, 5, 64, 5, 3, 2, T(10)],      // chunk 0,0
    [1, 6, 64, 6, 3, 2, T(20)],
    [1, 5, 64, 5, 2, 1, T(30)],
    [1, 40, 64, 5, 1, 0, T(40)],     // chunk 2,0
    [2, 5, 64, 5, 3, 1, T(50)],      // other dimension
  ]);
  const { buf, cellCount, rowCount, tMin, tMax } = buildPack(L, 1, 'region', {
    // A height lookup in the shape the bake passes it: chunk coordinate in, world Y or null out.
    heightOf: (cx, cz) => (cx === 0 && cz === 0 ? 71 : null),
  });
  assert.equal(cellCount, 2, 'two chunks in dimension 1');
  assert.equal(rowCount, 4);
  assert.equal(tMin, 1717174700);
  assert.equal(tMax, 1717174730);

  const P = readPack(buf);
  assert.equal(P.dimKey, 'region');
  assert.equal(P.worldId, 1);
  assert.equal(P.version, LEDPACK_VERSION);
  assert.equal(P.cellCount, 2);
  const a = P.cell(0);
  assert.deepEqual([a.cx, a.cz], [0, 0]);
  assert.deepEqual(a.counts, [0, 1, 2, 0, 0, 0], 'two breaks and one place, counted by action id');
  assert.equal(a.total, 3);
  assert.equal(a.playerMask, 0b11, 'both players touched this chunk');
  assert.deepEqual([a.firstSec, a.lastSec], [0, 20], 'the span of this chunk, relative to the dimension base');
  assert.equal(a.y, 71, 'the overlay stands on the ground the bake copied in');
  const b = P.cell(1);
  assert.deepEqual([b.cx, b.cz], [2, 0]);
  assert.equal(b.playerMask, 0, 'a source that is not a player leaves the mask clear');
  assert.equal(b.y, null, 'no height for a chunk the lookup did not answer -> unknown, not sea level');
});

test('a height plane of zeros means unknown, and a silly height is refused', () => {
  const L = fakeLog([[1, 5, 64, 5, 3, 2, T(10)]]);
  const plain = readPack(buildPack(L, 1, 'region').buf);
  assert.equal(plain.cell(0).y, null, 'no lookup at all is still a readable pack');
  assert.throws(() => buildPack(L, 1, 'region', { heightOf: () => 90000 }), /out of range/);
  assert.throws(() => buildPack(L, 1, 'region', { heightOf: () => -90000 }), /out of range/);
});

test('the chunk index finds a chunk, and its rows come back in time order', () => {
  const L = fakeLog([
    [1, 5, 0, 5, 3, 2, T(30)],
    [1, 5, 0, 5, 2, 2, T(10)],
    [1, 40, 0, 5, 1, 1, T(20)],
    [1, 5, 0, 21, 3, 1, T(40)],      // cz = 1
  ]);
  const { buf } = buildPack(L, 1, 'region');
  const P = readPack(buf);
  const hit = P.findChunk(0, 0);
  assert.ok(hit);
  assert.equal(hit.rowCount, 2);
  const order = [...Array(hit.rowCount)].map((_, k) => L.timeMs(P.rowIdx(hit.rowStart + k)));
  assert.deepEqual(order, [T(10), T(30)]);
  assert.ok(P.findChunk(2, 0), 'x 40 -> cx 2, z 5 -> cz 0');
  assert.ok(P.findChunk(0, 1), 'z 21 -> cz 1, and the index sorts by (cz, cx)');
  assert.equal(P.findChunk(2, 1), null, 'the two chunks are not diagonal neighbours');
  assert.equal(P.findChunk(7, 7), null, 'a chunk nobody touched answers "nothing"');
});

test('readPack takes whatever shape the caller happens to hold', () => {
  // Node hands over a Buffer; a browser fetch hands over an ArrayBuffer; and a Buffer read from disk is
  // a view into Node's shared allocation pool with a nonzero byteOffset. Getting this wrong used to look
  // like corrupt data on the page, because the DataView error was caught and reported as a stale bake.
  const { buf } = buildPack(fakeLog([
    [1, 5, 64, 5, 3, 2, T(10)],      // chunk 0,0
    [1, 6, 64, 6, 3, 2, T(20)],
    [1, 5, 64, 5, 2, 1, T(30)],
    [1, 40, 64, 5, 1, 0, T(40)],     // chunk 2,0
    [2, 5, 64, 5, 3, 1, T(50)],      // other dimension
  ]), 1, 'region', { heightOf: () => 70 });
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  const pooled = new Uint8Array(ab.byteLength + 8);
  pooled.set(buf, 8);
  for (const [name, src] of [['buffer', buf], ['arraybuffer', ab], ['offset view', pooled.subarray(8)]]) {
    const P = readPack(src);
    assert.equal(P.cellCount, 2, name);
    assert.deepEqual(P.cell(0), readPack(buf).cell(0), name);
    assert.deepEqual(P.findChunk(2, 0), { rowStart: 3, rowCount: 1 }, `${name}: the chunk index still bites`);
    assert.equal(P.heightOf(0), 70, `${name}: the height plane reads from the same offset`);
  }
});

test('a pack that is not a pack is an error, not an empty answer', () => {
  const { buf } = buildPack(fakeLog([[1, 0, 0, 0, 1, 1, T(0)]]), 1, 'region');
  const bad = Buffer.from(buf);
  bad.write('NOPE    ', 0, 'latin1');
  assert.throws(() => readPack(bad), /magic/);
  const badv = Buffer.from(buf);
  badv.writeUInt32LE(LEDPACK_VERSION + 5, 8);
  assert.throws(() => readPack(badv), /version/);
  assert.throws(() => readPack(buf.subarray(0, buf.length - 8)), /bytes needed/);
  assert.ok(buf.subarray(0, 8).toString('latin1') === LEDPACK_MAGIC);
});

test('the timeline walks the same rows in time order and carries the block position', () => {
  // Out of order in the log on purpose: the timeline is the playhead, so its order is its contract.
  const L = fakeLog([
    [1, 5, 64, 5, 3, 2, T(30)],
    [1, 6, 71, 6, 2, 1, T(10)],
    [1, 40, -60, 5, 1, 0, T(20)],    // chunk 2,0, and a y below 0 - the pack bias must survive it
    [2, 5, 64, 5, 3, 1, T(15)],      // other dimension: not this pack's business
  ]);
  const { buf, rowCount } = buildPack(L, 1, 'region', { heightOf: () => 71 });
  const P = readPack(buf);
  assert.equal(P.tlCount, rowCount, 'every row in the pack is on the timeline');
  const TL = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  assert.equal(TL.count, 3);
  assert.equal(TL.dimKey, 'region');

  const world = (i) => {
    const c = P.cell(TL.cellOf(i));
    return [c.cx * 16 + TL.x(i), TL.y(i), c.cz * 16 + TL.z(i)];
  };
  assert.deepEqual(world(0), [6, 71, 6], 'oldest first');
  assert.deepEqual(world(1), [40, -60, 5], 'a negative y round-trips');
  assert.deepEqual(world(2), [5, 64, 5]);
  assert.deepEqual([...TL.player], [0, TL_NO_PLAYER, 1], 'no player is 255, not 0 - id 0 is the no-player row');
  assert.deepEqual([...TL.action], [1, 0, 2], 'action ids 1..6 arrive as 0..5');
  assert.deepEqual([...TL.sec], [0, 10, 20], 'seconds since the pack time base, which is the oldest row');
  assert.equal(TL.second(1), Math.floor(T(20) / 1000), 'and second() gets back the log time');

  // Rows are ordered, so a time window is two binary searches rather than a filter over 351k rows.
  assert.deepEqual(TL.range(5, 15), [1, 2], 'one row sits in that window');
  assert.deepEqual(world(TL.range(5, 15)[0]), [40, -60, 5], 'and it is the middle one in time');
  assert.deepEqual(TL.range(0, 999), [0, 3]);

  // A cell index that does not exist in the cells table would put a decal in the void.
  for (let i = 0; i < TL.count; i++) {
    assert.ok(TL.cellOf(i) < P.cellCount, `row ${i} names cell ${TL.cellOf(i)} of ${P.cellCount}`);
  }

  // The served cells slice declares the timeline absent; a reader must not find one in it.
  const cellsOnly = Buffer.from(buf.subarray(0, 44 + 6 + P.cellCount * 34));
  const cdv = new DataView(cellsOnly.buffer, cellsOnly.byteOffset, cellsOnly.length);
  for (const at of [24, 28, 40]) cdv.setUint32(at, 0, true);   // chunkCount, rowCount, tlCount
  assert.equal(readPack(cellsOnly).tlBytes, null, 'a cells-only slice says it has no timeline');
});

test('the timeline names the block each row is about, which is what lets terrain be put back', () => {
  const L = fakeLog([
    [1, 5, 64, 5, 3, 2, T(30), 'minecraft:air', 'minecraft:stone'],   // a break names what left
    [1, 5, 65, 5, 2, 2, T(40), 'minecraft:oak_stairs[facing=north]', 'minecraft:air'],
    [1, 5, 66, 5, 5, 2, T(50)],                                       // an action with nothing on it
    [1, 5, 67, 5, 3, 2, T(60), '', 'minecraft:stone'],                // same name again: one table slot
  ]);
  const { buf, nameCount } = buildPack(L, 1, 'region');
  const P = readPack(buf);
  const TL = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  assert.equal(TL.version, 2);
  assert.deepEqual([...TL.name], [1, 2, 0, 1], 'interned, deduplicated, and 0 means the row names nothing');
  assert.equal(TL.names.length, 2, 'the table is per dimension, and repeats cost nothing');
  assert.equal(nameCount, 2);
  assert.equal(TL.nameOf(0), 'minecraft:stone', 'a break reads its old object, not the air left behind');
  assert.equal(TL.nameOf(1), 'minecraft:oak_stairs[facing=north]');
  assert.equal(TL.nameOf(2), '', 'a row that names nothing answers the empty string, not undefined');
  assert.equal(TL.nameOf(3), 'minecraft:stone');
  // The name table sits between the dim key and the rows, so a slice cut inside it is a broken file.
  assert.throws(() => decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[0] + 60)), /bytes needed/);
});

test('a timeline that stops short is refused, not read as a shorter history', () => {
  const L = fakeLog([[1, 0, 0, 0, 1, 1, T(0)], [1, 1, 0, 1, 2, 1, T(5)], [1, 2, 0, 2, 3, 2, T(9)]]);
  const { buf } = buildPack(L, 1, 'region');
  const P = readPack(buf);
  assert.throws(() => readPack(buf.subarray(0, P.tlBytes[1] - 1)), /bytes needed/);
  const bad = Buffer.from(buf);
  bad.write('NOPE    ', P.tlBytes[0], 'latin1');
  assert.throws(() => readPack(bad), /timeline magic/);
  // A y the 13-bit field cannot hold is a bake error, not a silently wrapped coordinate.
  assert.throws(() => buildPack(fakeLog([[1, 0, 99999, 0, 1, 1, T(0)]]), 1, 'region'),
    /outside the packed range/);
  assert.throws(() => decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1] - 1)), /bytes needed/);
});

// --------------------------------------------------------------------------- real data

const have = (p) => existsSync(p) && statSync(p).size < 200 * 1024 * 1024;

test('the baked overworld pack agrees with the log it came from', (t) => {
  const packPath = 'build/ledger/region.ledpack';
  const exportPath = 'build/ledger/actions.bin';
  if (!have(packPath) || !have(exportPath)) return t.skip('not baked yet');
  const L = readLedger(readFileSync(exportPath));
  const P = readPack(readFileSync(packPath));

  // Count the same thing twice: once by walking the log, once by walking the pack.
  let rows = 0; const chunks = new Map();
  for (let i = 0; i < L.count; i++) {
    if (L.worldId(i) !== 1) continue;
    rows++;
    chunks.set(`${L.z(i) >> 4}|${L.x(i) >> 4}`, (chunks.get(`${L.z(i) >> 4}|${L.x(i) >> 4}`) ?? 0) + 1);
  }
  assert.equal(P.rowCount, rows);
  assert.equal(P.cellCount, chunks.size);

  // Every cell must name the rows the log says it holds, and findChunk must agree with the cell.
  for (let c = 0; c < P.cellCount; c++) {
    const e = P.cell(c);
    assert.equal(e.counts.reduce((a, b) => a + b, 0), chunks.get(`${e.cz}|${e.cx}`), `chunk ${e.cx},${e.cz}`);
    const hit = P.findChunk(e.cx, e.cz);
    assert.ok(hit, `index lookup for ${e.cx},${e.cz}`);
    assert.equal(hit.rowCount, e.total);
    for (let k = 0; k < hit.rowCount; k++) {
      const i = P.rowIdx(hit.rowStart + k);
      assert.equal(L.x(i) >> 4, e.cx, `row ${i} x`);
      assert.equal(L.z(i) >> 4, e.cz, `row ${i} z`);
      assert.equal(L.worldId(i), 1, `row ${i} dim`);
    }
  }
  // The busiest chunk in this log, checked as a specific number rather than a plausibility.
  const hot = P.findChunk(-3, -8);
  assert.ok(hot);
  assert.equal(hot.rowCount, 4254, 'total rows: 3,884 of them are player-attributed');
  const e0 = [...Array(P.cellCount)].map((_, c) => P.cell(c)).find((e) => e.cx === -3 && e.cz === -8);
  assert.equal(e0.playerMask, 63, 'all six players appear in the busiest chunk');
});

test('the baked timeline is the same rows as the point query, reordered', (t) => {
  const packPath = 'build/ledger/region.ledpack';
  const exportPath = 'build/ledger/actions.bin';
  if (!have(packPath) || !have(exportPath)) return t.skip('not baked yet');
  const L = readLedger(readFileSync(exportPath));
  const raw = readFileSync(packPath);
  const P = readPack(raw);
  const TL = decodeTimeline(raw.subarray(P.tlBytes[0], P.tlBytes[1]));
  // The size asymmetry that justifies two endpoints: 34 B per touched chunk against 16 B per row.
  // Overworld that is 691 KB of heat versus 5.6 MB of playhead, so the heat layer must not carry it.
  let nameBytes = 0;
  for (const s of TL.names) nameBytes += 2 + Buffer.from(s, 'utf8').length;
  assert.equal(P.tlBytes[1] - P.tlBytes[0], TL_HEADER + P.dimKey.length + nameBytes + TL.count * TL_REC);
  assert.ok(TL.names.length > 100, 'the overworld names a few hundred distinct blocks');
  assert.ok(P.tlBytes[1] - P.tlBytes[0] > 4.5e6, 'the overworld timeline is a few MB, not a rounding error');

  // Row count, first and last second, and the rows per cell: the timeline may not invent, lose, or
  // relocate a row relative to the section the click-a-block path reads.
  assert.equal(TL.count, P.rowCount);
  let first = Infinity, last = -Infinity;
  for (let c = 0; c < P.cellCount; c++) {
    const e = P.cell(c);
    first = Math.min(first, e.firstSec); last = Math.max(last, e.lastSec);
  }
  assert.equal(TL.sec[0], first, 'the timeline starts at the oldest cell');
  assert.equal(TL.sec[TL.count - 1], last, 'and ends at the newest');
  assert.equal(TL.timeBaseSec, P.timeBaseSec, 'and shares the pack time base, so seconds compare directly');

  const perCell = new Int32Array(P.cellCount);
  const perAction = new Int32Array(NCLASS);
  const perPlayer = new Int32Array(256);   // index 255 is the no-player marker
  for (let i = 0; i < TL.count; i++) {
    perCell[TL.cellOf(i)]++;
    if (TL.action[i] < NCLASS) perAction[TL.action[i]]++;
    perPlayer[TL.player[i]]++;
    // The local coordinate has to land inside the 16x16 its cell names, or a decal lands in the void.
    assert.ok(TL.x(i) >= 0 && TL.x(i) < 16 && TL.z(i) >= 0 && TL.z(i) < 16, `row ${i} local coord`);
    assert.ok(TL.y(i) >= -2000 && TL.y(i) < 2000, `row ${i} y ${TL.y(i)}`);
  }
  for (let c = 0; c < P.cellCount; c++) {
    assert.equal(perCell[c], P.cell(c).total, `cell ${c} row count`);
  }
  for (let a = 0; a < NCLASS; a++) {
    let n = 0;
    for (let c = 0; c < P.cellCount; c++) n += P.cell(c).counts[a];
    assert.equal(perAction[a], n, `action ${a + 1} row count`);
  }
  // Six players in this log. The unattributed count is not a guess: count the same rows in the log.
  let unattributed = 0;
  for (let i = 0; i < L.count; i++) if (L.worldId(i) === 1 && !L.playerId(i)) unattributed++;
  assert.equal(perPlayer[TL_NO_PLAYER], unattributed, 'rows with no player keep a 255 marker');
  // 269,358 of 351,531 overworld rows have no player at all - 77%. That is a fact about this log, not a
  // pack bug: most of what the ledger recorded was not credited to a person. It matters for the time
  // machine, because "only playerA's blocks" would hide three quarters of what changed.
  assert.equal(unattributed, 269358, 'the unattributed majority, measured');
  assert.ok(perPlayer[0] > 20000, 'playerA is still the busiest player after the reorder');
  assert.equal(TL.count, 351531, 'the overworld row count is a fact, not a plausibility');

  // Same rows, reordered: for the busiest chunk, the timeline's seconds for that cell must be exactly
  // the seconds the point query returns for it. Two independent paths over the same log.
  const hotCell = [...Array(P.cellCount).keys()].find((c) => P.cell(c).cx === -3 && P.cell(c).cz === -8);
  const fromTl = [];
  for (let i = 0; i < TL.count; i++) if (TL.cellOf(i) === hotCell) fromTl.push(TL.second(i));
  const hit = P.findChunk(-3, -8);
  const fromRows = [];
  for (let k = 0; k < hit.rowCount; k++) {
    fromRows.push(Math.floor(L.timeMs(P.rowIdx(hit.rowStart + k)) / 1000));
  }
  fromRows.sort((a, b) => a - b);
  assert.equal(fromTl.length, 4254, 'the hot chunk contributes 4,254 rows to the timeline');
  assert.deepEqual(fromTl, fromRows, 'hot chunk: the same seconds, in the same order');
});

test('the baked pack stands on ground, not on a guess', (t) => {
  const packPath = 'build/ledger/region.ledpack';
  if (!have(packPath)) return t.skip('not baked yet');
  const P = readPack(readFileSync(packPath));
  // Every touched chunk of a real dimension has ground under it, so the height plane must be filled
  // in - and it must be terrain, not the sentinel. Overworld ground in this save sits well above
  // the void floor and well under the build limit.
  let known = 0, lo = Infinity, hi = -Infinity;
  for (let c = 0; c < P.cellCount; c++) {
    const y = P.cell(c).y;
    if (y === null) continue;
    known++;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  assert.ok(known > P.cellCount * 0.98, `${known}/${P.cellCount} cells carry a ground height`);
  assert.ok(lo > -64 && hi < 400, `heights ${lo}..${hi} are terrain, not a sentinel`);
});
