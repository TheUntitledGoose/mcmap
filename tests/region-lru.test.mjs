// The region-file LRU must never be asked to evict something it cannot evict.
//
// Panning far out requests regions that were never written. A missing region used to be remembered in
// the same LRU list as an open file, and the "keep at most 48 open" loop re-queued what it could not
// drop: with 437 written overworld regions and ~950 unwritten region slots inside the save's own
// extent, a pull-back fills that list with entries that can never leave it, the loop spins forever and
// the process stops answering. That is the 11/07 "worldd is dead, I panned out" incident.
//
// The list also used indexOf on every lookup, so even before it wedged, a 64x64 far block (4,096
// chunk slots) paid an O(kept entries) scan per slot.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const atlas = JSON.parse(fs.readFileSync(path.join('build', 'assets', 'atlas.json'), 'utf8'));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const DIM = 'minecraft:overworld';
const svc = () => new WorldService('DarkRPG/world', ids, 'build/cache', { packDir: null });

test('a pan across unwritten regions terminates, and the open-file list stays bounded', () => {
  const s = svc();
  const t0 = performance.now();
  // Chunk coordinates out past the save's own extent in both directions: 3,000 slots spread over
  // ~100 region files that do not exist, with a real region in the middle of them.
  for (let rz = -60; rz <= 60; rz++) {
    s.chunkBytes(DIM, 31 * rz, 31 * rz);            // a mix of present and absent as rz walks
    for (let rx = -40; rx <= 40; rx += 7) s.chunkBytes(DIM, 32 * rx + 3000, 32 * rz + 4000);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 4000, `941 lookups took ${ms.toFixed(0)} ms - the LRU eviction loop is spinning`);
  assert.ok(s.order.length <= 48, `open-region list grew to ${s.order.length}`);
  for (const p of s.order) {
    assert.ok(s.regions.get(p)?.rgn, 'only genuinely open region files belong in the eviction list');
  }
});

test('a far block over unwritten ground is priced by the walk, not by the number of kept paths', () => {
  const s = svc();
  // Fill the negative set first (this is what a pull-back leaves behind), then time one real block.
  for (let rz = -90; rz <= 90; rz++) for (let rx = -90; rx <= 90; rx += 9) s.chunkBytes(DIM, 32 * rx + 6000, 32 * rz + 6000);
  const kept = s.order.length;
  const t0 = performance.now();
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) s.chunkBytes(DIM, -9000 + i, 5000 + j);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `4,096 absent slots took ${ms.toFixed(0)} ms with ${kept} paths kept`);
});

test('a far pan cannot starve the eviction list of evictable entries', () => {
  const s = svc();
  // 60 region files that do not exist, each looked up twice. The second lookup is the one that used to
  // re-queue the remembered miss in the eviction list, and the eviction loop put it straight back.
  const miss = [];
  for (let rz = 0; rz < 6; rz++) for (let rx = 0; rx < 10; rx++) miss.push([32 * rx + 4000, 32 * rz + 4000]);
  for (const [cx, cz] of miss) s.chunkBytes(DIM, cx, cz);
  assert.equal(s.stats.missing, 60, 'each absent region is recognised once');
  for (const [cx, cz] of miss) s.chunkBytes(DIM, cx, cz);
  assert.equal(s.stats.missHits, 60, 'the second pass is answered from memory, not by stat');
  assert.equal(s.order.length, 0, 'a remembered miss must not sit in the open-file eviction list');
  // Then pan back onto written ground. On the old code this is where the loop span: `order` held 60
  // entries that could never leave it, and opening a real region tried to trim it to 48.
  const t0 = performance.now();
  for (let rz = 0; rz < 4; rz++) for (let rx = 0; rx < 4; rx++) s.chunkBytes(DIM, 32 * rx, 32 * rz);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `panning back onto written ground took ${ms.toFixed(0)} ms`);
});

test('a region file that appears later is still found', async () => {
  try {
    const world = fs.mkdtempSync(path.join(fs.realpathSync('.'), 'build', 'newworld-'));
    const regDir = path.join(world, 'region');
    fs.mkdirSync(regDir, { recursive: true });
    fs.writeFileSync(path.join(world, 'level.dat'), Buffer.alloc(0));
    const s = new WorldService(world, ids, 'none', { packDir: null, missingTtlMs: 20 });
    const before = s.chunkBytes(DIM, 3, 4);
    assert.equal(before, null, 'nothing exists yet');
    // Same bytes the real save has for that slot, copied into a fresh region file.
    const src = path.join('DarkRPG', 'world', 'region', 'r.0.0.mca');
    fs.copyFileSync(src, path.join(regDir, 'r.0.0.mca'));
    await new Promise((r) => setTimeout(r, 40));
    const after = s.chunkBytes(DIM, 3, 4);
    assert.ok(after && after.length > 100, 'a region written after the miss must be read once the miss expires');
    // Windows will not delete a file another handle still has open, so hand the region files back first.
    for (const e of s.regions.values()) { try { e.rgn?.close(); } catch { } }
    fs.rmSync(world, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch (e) {
    if (!fs.existsSync(path.join('DarkRPG', 'world', 'region', 'r.0.0.mca'))) throw e;
    throw e;
  }
});
