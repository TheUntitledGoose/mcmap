// Region coverage: the answer to "is there any ground in this rectangle?" without walking it.
//
// Why it exists: the far-pan incident spent 16.8 s of server time walking 258,048 chunk slots in
// region files that were never written. The save's bounding box covers 1,734 region cells and has
// 437 files - three quarters of the box is empty ground, and both the server (batch walks) and the
// browser (tile requests) were paying for it slot by slot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { packCells, makeReader, toWire, fromWire } from '../shared/regionbits.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openShellBatch } from '../web/js/payload.js';
import { compress } from '../server/world-service.mjs';

const atlas = JSON.parse(fs.readFileSync(path.join('build', 'assets', 'atlas.json'), 'utf8'));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const DIM = 'minecraft:overworld';
const svc = () => new WorldService('DarkRPG/world', ids, 'build/cache', { packDir: null });

test('the bit grid says what the directory says, over its own bounding box', () => {
  const cells = [{ rx: -3, rz: 5 }, { rx: 2, rz: 7 }, { rx: -3, rz: 7 }];
  const r = makeReader(packCells(cells));
  assert.equal(r.x0, -3); assert.equal(r.z0, 5); assert.equal(r.w, 6); assert.equal(r.h, 3);
  assert.equal(r.count, 3);
  assert.ok(r.has(-3, 5) && r.has(2, 7) && r.has(-3, 7));
  assert.ok(!r.has(-3, 6) && !r.has(0, 5) && !r.has(-4, 5), 'the hole in the box stays a hole');
  assert.ok(!r.has(-99, 5), 'outside the box is empty, not unknown');
  assert.deepEqual(packCells([]), null, 'no cells means no grid, and consumers must fail open');
});

test('hasAny answers a chunk rectangle, not a chunk', () => {
  const r = makeReader(packCells([{ rx: 0, rz: 0 }]));
  assert.ok(r.hasAny(0, 0, 1, 1));
  assert.ok(r.hasAny(31, 31, 1, 1), 'the far corner of the region still belongs to it');
  assert.ok(r.hasAny(-5, -5, 40, 40), 'a rectangle that straddles the region counts');
  assert.ok(!r.hasAny(32, 0, 1, 1), 'one region over is a different file');
  // A 64x64 block spans four region cells; it is empty only if all four are. Outside the grid is
  // empty too: the grid is the save's own bounding box, and the caller already clipped to it.
  assert.ok(!r.hasAny(32, 32, 64, 64), 'all four cells of the block are outside');
  assert.ok(!r.hasAny(0, 32, 64, 64), 'the cell below the only file is a hole, not unknown');
});

test('the wire form round-trips and stays small', () => {
  const grid = packCells([{ rx: 0, rz: 0 }, { rx: 33, rz: 9 }]);
  const back = makeReader(fromWire(toWire(grid)));
  assert.equal(back.count, 2);
  assert.ok(back.has(33, 9) && !back.has(32, 9));
  // Two cells 33 regions apart need a 34x10 grid: 340 cells, 43 bytes. Small enough that the JSON
  // array form costs a few hundred bytes and no codec on either side.
  assert.equal(grid.w, 34); assert.equal(grid.h, 10);
  assert.equal(grid.bits.length, 43, 'bits sized by the box area, not the cell count');
});

test('the service knows its own coverage, and fails open for dimensions it does not have', () => {
  const s = svc();
  const d = s.resolve(DIM);
  const r = s.coverageFor(DIM);
  assert.equal(r.count, d.regions, 'the grid counts exactly the region files on disk');
  const e = d.chunkExtent;
  // The bounding box's edges each come from a real file, but its corner need not: assert the edges,
  // not the corners.
  assert.ok(r.hasAny(e.minX, e.minZ, e.maxX - e.minX + 1, 1), 'the far z edge holds a file');
  assert.ok(r.hasAny(e.minX, e.maxZ, e.maxX - e.minX + 1, 1), 'the near z edge holds a file');
  assert.ok(r.hasAny(e.minX, e.minZ, 1, e.maxZ - e.minZ + 1), 'the far x edge holds a file');
  assert.ok(!r.hasAny(e.minX - 32, e.minZ - 32, 1, 1), 'one region outside the box is empty');
  assert.ok(s.hasGround('no-such-dimension', 0, 0, 64, 64), 'unknown dimension must not read as empty ground');
  assert.ok(s.hasGround(DIM, e.minX, e.minZ, e.maxX - e.minX + 1, e.maxZ - e.minZ + 1), 'the whole box holds ground somewhere');
});

test('a batch over ground that was never written is answered without a slot walk', async () => {
  const s = svc();
  const e = s.resolve(DIM).chunkExtent;
  // Inside the bounding box, outside every region file: the case the walk used to pay for.
  const r = s.coverageFor(DIM);
  let cx = null, cz = null;
  for (let rz = r.z0; rz + 1 < r.z0 + r.h && cx === null; rz++) {
    for (let rx = r.x0; rx + 1 < r.x0 + r.w && cx === null; rx++) {
      // A 64x64 block covers four region cells, so all four have to be empty for the skip to fire.
      if (!r.has(rx, rz) && !r.has(rx + 1, rz) && !r.has(rx, rz + 1) && !r.has(rx + 1, rz)
        && r.has(rx - 2, rz) && r.has(rx + 3, rz)) { cx = rx * 32; cz = rz * 32; }
    }
  }
  assert.ok(cx !== null, 'this save has holes inside its own box (that is the point)');
  const buf = await s.shellBatchBytesAsync(DIM, cx, cz, 64, 64);
  assert.equal(s.stats.coverageSkips, 1, 'answered from coverage');
  assert.equal(s.stats.coverageSlots, 64 * 64, 'and it is charged for the slots it did not walk');
  assert.equal(s.stats.missing, 0, 'no region file was even opened');
  const frames = openShellBatch(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), 64, 64);
  assert.equal(frames.length, 4096);
  assert.ok(frames.every((f) => !f), 'an empty batch is still an explicit all-empty answer');
});

test('coverage never hides ground: the same batch over real chunks is byte-identical', async () => {
  const a = svc();
  const bufA = await a.batchBytesAsync(DIM, -20, -30, 4, 4);
  const b = svc();
  b.hasGround = () => true;               // force the old walk
  const bufB = await b.batchBytesAsync(DIM, -20, -30, 4, 4);
  assert.equal(bufA.length, bufB.length, 'the skip must not change the answer');
  assert.ok(bufA.equals(bufB));
  assert.ok(bufA.length > 10_000, 'sample must be real payload, not an empty batch');
  assert.equal(a.stats.coverageSkips, 0, 'real ground is never skipped');
  assert.ok(compress(bufA).length < bufA.length, 'and it is worth gzipping on the wire');
});

test('a region written after the listing went stale is seen again', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('.'), 'build', 'cover-'));
  try {
    const dir = path.join(root, 'world', 'region');
    fs.mkdirSync(dir, { recursive: true });
    const s = new WorldService(path.join(root, 'world'), ids, 'none', { coverageTtlMs: 30 });
    // A dimension with nothing listed fails open: coverage may skip a walk over a box it has seen,
    // never hide ground it has not.
    assert.ok(s.hasGround(DIM, 100, 100, 16, 16), 'an empty listing fails open');
    fs.writeFileSync(path.join(dir, 'r.3.3.mca'), Buffer.alloc(8));
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(s.hasGround(DIM, 100, 100, 16, 16), 'the file that appeared is inside the listing now');
    assert.ok(!s.hasGround(DIM, 132, 100, 16, 16), 'the region next door is a known hole');
    fs.writeFileSync(path.join(dir, 'r.4.3.mca'), Buffer.alloc(8));
    assert.ok(!s.hasGround(DIM, 132, 100, 16, 16), 'a fresh listing is trusted, not re-statted per request');
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(s.hasGround(DIM, 132, 100, 16, 16), 'a stale listing is re-read: a world still generating is visible');
    assert.equal(s.cacheDir, null, "cacheDir 'none' means no cache, not a directory named none");
    const w = s.coverageWire(DIM);
    assert.equal(w.cells, 2, 'the browser is told what the disk says now, not what it said at boot');
    assert.equal(makeReader(fromWire(w)).count, 2, 'and the wire form carries it intact');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
