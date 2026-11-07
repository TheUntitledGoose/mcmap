// tests/cutpolicy.test.mjs - the far pass must price a cut by the patch it is about to cut.
//
// Why this file exists: the pass asked "does the *average* measured cut fit the rest of the frame?".
// 86 % of cuts go to a worker (0.15 ms of main-thread work), so the average *inline* cut was set by the
// cheap small-cell patches, and the first cut of a frame was allowed unconditionally. A cell-1 patch is
// 4 096 block columns: it started 1 ms into a 10 ms frame and the frame paid 47 ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordCut, cutPrice, decideCut, mayTakeThread } from '../shared/cutpolicy.mjs';

test('a per-cell table separates a 47 ms patch from a 2 ms patch', () => {
  const t = new Map();
  for (let i = 0; i < 20; i++) recordCut(t, 8, 2);
  recordCut(t, 1, 47);
  assert.equal(cutPrice(t, 8), 2);
  assert.equal(cutPrice(t, 1), 47);
  // the old bug in one assertion: the blended average of those samples
  const blended = (20 * 2 + 47) / 21;
  assert.ok(cutPrice(t, 1) > 3 * blended,
    'a cell-1 patch has to be priced far above the blend that hid it');
});

test('an unmeasured cell falls back to the global average, and never below the floor', () => {
  const t = new Map();
  recordCut(t, 4, 6);
  assert.equal(cutPrice(t, 16, 6), 6, 'no sample for cell 16: believe the global average');
  assert.equal(cutPrice(t, 16, 0), 2, 'no evidence at all: a cut is not free');
  assert.equal(cutPrice(t, 16, 0.01, 5), 5);
});

test('a worker always wins: cost does not travel with the render thread', () => {
  assert.equal(decideCut({ cell: 1, priceMs: 47, remainingMs: 0, inflight: 0, cap: 6 }), 'worker');
  // ... and only when a thread is actually free
  assert.notEqual(decideCut({ cell: 1, priceMs: 47, remainingMs: 0, inflight: 6, cap: 6 }), 'worker');
});

test('the bug: an expensive cut is not started because it is the first one in the frame', () => {
  // 47 ms patch, 10 ms budget left, all six patch threads busy. The old code allowed the first cut of a
  // frame whatever it cost; that is the 47 ms frame.
  const d = decideCut({ cell: 1, priceMs: 47, remainingMs: 10, inflight: 6, cap: 6, waitedMs: 30 });
  assert.equal(d, 'defer', 'the frame must not pay for a cut it cannot afford');
  // a cheap patch in the same frame is still served
  assert.equal(decideCut({ cell: 8, priceMs: 2, remainingMs: 10, inflight: 6, cap: 6, waitedMs: 30 }),
    'inline');
});

test('deferral is not forever: a starved patch is cut anyway', () => {
  // Nothing on screen, and the patch has been dirty for 500 ms: this is a hole in the ground, and the
  // pass would never settle while it stays marked.
  assert.equal(decideCut({ cell: 1, priceMs: 47, remainingMs: 0, inflight: 6, cap: 6,
    waitedMs: 500, starveMs: 400, hasMesh: false }), 'force');
  // a re-cut can wait, because the previous mesh is still painted
  assert.equal(decideCut({ cell: 1, priceMs: 47, remainingMs: 0, inflight: 6, cap: 6,
    waitedMs: 500, starveMs: 0 }), 'defer', 'starveMs 0 = never force');
});

test('cost grows as the cell gets finer, so a fine cell is the one that needs a thread', () => {
  const t = new Map();
  for (const cell of [16, 8, 4, 2, 1]) recordCut(t, cell, 160 / cell);
  let prev = 0;
  for (const cell of [16, 8, 4, 2, 1]) {
    const p = cutPrice(t, cell);
    assert.ok(p >= prev, `cell ${cell} should cost at least cell ${cell * 2}`);
    prev = p;
    // with no thread free and a 10 ms budget left, nothing at cell 4 or finer may be cut inline
    const d = decideCut({ cell, priceMs: p, remainingMs: 10, inflight: 4, cap: 4, waitedMs: 5 });
    if (cell <= 4) assert.notEqual(d, 'inline', `cell ${cell} costs ${p} ms`);
    if (cell === 16) assert.equal(d, 'inline', 'the cheap cell is exactly what inline is for');
  }
});

test('an idle thread is not a reason to block an expensive cut', () => {
  // The cap holds threads back for chunk detail meshes. At cell 1 that reservation is protecting the
  // render thread from nothing: the alternative to the thread is a 33 ms mesh on it.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 33, stealMs: 20,
    workerFree: true }), true);
  // ... but a cheap cut has no such excuse, and stays inside the reservation.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 9, stealMs: 20,
    workerFree: true }), false);
  // Nothing is idle: there is no thread to take, however expensive the cut is.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 33, stealMs: 20,
    workerFree: false }), false);
  // Every thread is already on a far cut: stealing would just be double-booking.
  assert.equal(mayTakeThread({ inflight: 8, cap: 4, poolSize: 8, priceMs: 33, stealMs: 20,
    workerFree: true }), false);
  // ?stealms=0 is the A/B: the old hard cap.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 33, stealMs: 0,
    workerFree: true }), false);
  // Under the cap, a free thread is taken whatever the price.
  assert.equal(mayTakeThread({ inflight: 1, cap: 4, poolSize: 8, priceMs: 1, stealMs: 20,
    workerFree: true }), true);
});

test('a thread is only spare when chunk detail has no use for it', () => {
  // The cap reserves threads for chunk detail. An idle thread while detail waits belongs to detail -
  // it will be asked for a mesh inside the same frame.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 33, stealMs: 20,
    workerFree: true, detailWaiting: 3 }), false, 'detail is next in line');
  // With nothing waiting, the same thread is spare, and a 33 ms inline cut would be the worse answer.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 33, stealMs: 20,
    workerFree: true, detailWaiting: 0 }), true);
  // Cheap cuts still stay inside the reservation whatever is waiting: inline is cheap for them.
  assert.equal(mayTakeThread({ inflight: 4, cap: 4, poolSize: 8, priceMs: 6, stealMs: 20,
    workerFree: true, detailWaiting: 0 }), false);
});
