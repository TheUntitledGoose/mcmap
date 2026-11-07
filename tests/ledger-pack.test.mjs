// The pack is a writer/reader pair over a binary layout, and the point query depends on the chunk
// index being sorted and the row slices being in time order. All three are checked here on a made-up
// log, and then against the real packs when they exist.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { LEDPACK_MAGIC, LEDPACK_VERSION, readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { readLedger } from '../shared/ledger-format.mjs';

// A log is only ever read through its accessor functions, so a test log can be built the same way.
const fakeLog = (rows) => {
  const R = rows.map(([worldId, x, y, z, actionId, playerId, timeMs]) =>
    ({ worldId, x, y, z, actionId, playerId, timeMs }));
  return {
    count: R.length,
    worldId: (i) => R[i].worldId,
    x: (i) => R[i].x,
    z: (i) => R[i].z,
    actionId: (i) => R[i].actionId,
    playerId: (i) => R[i].playerId,
    timeMs: (i) => R[i].timeMs,
  };
};

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
