// tests/pool.test.mjs - the mesh pool is one pool and two workloads; the split is policy, so it is tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutReserve, patchThreadCap } from '../shared/pool.mjs';

test('a cut reservation is sized by what the cut queue can start, not by its queue length', () => {
  // 8 threads, cap 6, 400 far patches wanting a cut, nothing running.
  // The old rule held back min(cap, pool-1) = 7 of 8 and left chunk detail one thread: a pan's worth
  // of detail chunks took 13+ s to mesh, which is the "detailed chunks are not loading" bug.
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 400, patchInflight: 0, poolSize: 8 }), 2);
  // One patch wanting a cut is not worth parking two threads for.
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 1, patchInflight: 0, poolSize: 8 }), 1);
  // Nothing wanting a cut: chunk jobs get the whole pool.
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 0, patchInflight: 0, poolSize: 8 }), 0);
  // Ceiling already running: waiting for more cuts would idle threads for nothing.
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 400, patchInflight: 6, poolSize: 8 }), 0);
  // Only part of the ceiling is running, so room for one more.
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 400, patchInflight: 5, poolSize: 8 }), 1);
  // Never reserve every thread: a pool of 2 with cuts waiting still runs chunk jobs.
  assert.equal(cutReserve({ patchCap: 1, dirtyPatches: 50, patchInflight: 0, poolSize: 2 }), 1);
  assert.equal(cutReserve({ patchCap: 6, dirtyPatches: 50, patchInflight: 0, poolSize: 1 }), 0);
  assert.equal(cutReserve({ patchCap: 0, dirtyPatches: 50, patchInflight: 0, poolSize: 8 }), 0);
});

test('chunk detail never loses the pool to far cuts', () => {
  // patchThreadCap is the ceiling on concurrent cuts; it always leaves at least one chunk thread.
  assert.equal(patchThreadCap({ poolSize: 8, want: 6 }), 6);
  assert.equal(patchThreadCap({ poolSize: 4, want: 6 }), 2);   // small machine: 4 workers, 2 cut threads
  assert.equal(patchThreadCap({ poolSize: 3, want: 6 }), 1);
  // A 2-thread machine keeps both threads for chunk detail: far cuts then run inline on the render
  // thread, which is the old behaviour and the honest trade on a machine that only has two.
  assert.equal(patchThreadCap({ poolSize: 2, want: 6 }), 0);
  assert.equal(patchThreadCap({ poolSize: 1, want: 6 }), 0);
  assert.equal(patchThreadCap({ poolSize: 8, want: 0 }), 0);
  // Whatever the ceiling, cuts running plus threads held back for cuts must always leave a chunk
  // thread at every point of the ramp - that is what keeps detail meshing alive while the far grid works.
  for (const pool of [1, 2, 4, 6, 8, 16]) {
    const cap = patchThreadCap({ poolSize: pool, want: 6 });
    assert.ok(cap <= pool - 1, `pool ${pool}: cap ${cap} must leave a chunk thread`);
    for (let inflight = 0; inflight <= cap; inflight++) {
      const held = inflight + cutReserve({ patchCap: cap, dirtyPatches: 999, patchInflight: inflight,
        poolSize: pool });
      assert.ok(held <= pool - 1,
        `pool ${pool}, cap ${cap}, ${inflight} in flight: ${held} threads on cuts leaves no chunk thread`);
    }
    assert.equal(cutReserve({ patchCap: cap, dirtyPatches: 999, patchInflight: cap, poolSize: pool }), 0);
  }
});
