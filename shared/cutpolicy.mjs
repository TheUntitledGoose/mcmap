// shared/cutpolicy.mjs - what the far shell pass may start inside a frame.
//
// The far pass meshes "patches" of heightmap columns. A patch's cost is not a property of the pass:
// it is a property of the patch. One patch at cell 1 is 4 096 block columns and measured 47 ms; a
// patch at cell 8 is 64 columns and measured ~2 ms. The old gate asked "does the average cut fit?" -
// and since 86 % of cuts go to a worker, the average *inline* cut was priced by the cheap patches, so
// an expensive one started 9 ms into a 10 ms frame and the frame paid 47 ms. That is the hitch left
// in a pan at whole-world framing.
//
// So price by cell, prefer the worker path, and never let a patch be deferred forever: a patch with
// no mesh on screen is a hole in the ground, and a patch that stays dirty forever means a pan never
// finishes settling.

/**
 * Blend a measured cut cost into a per-cell table.
 *
 * Cells are coarse-to-fine (16 = one column per 16x16 blocks, 1 = one column per block), and cost
 * grows roughly as cell^-2. A table entry is only trusted once sampled, hence the fallback.
 *
 * @param table   Map-like: cell -> { ms, n } (mutated)
 * @param cell    the cell size the cut ran at
 * @param ms      measured cost of that cut
 */
export function recordCut(table, cell, ms) {
  if (!(ms >= 0) || !(cell >= 1)) return;
  const key = cell | 0;
  const e = table.get(key) ?? { ms, n: 1 };
  if (table.has(key)) e.ms += (ms - e.ms) / ++e.n;
  table.set(key, e);
}

/**
 * What the next cut at `cell` is expected to cost. Never below a floor, because an unmeasured cell
 * must not be treated as free, and never below the global average when that is the only evidence.
 */
export function cutPrice(table, cell, fallback = 0, floor = 2) {
  const e = table.get(cell | 0);
  return Math.max(floor, e ? e.ms : Math.max(0, fallback));
}

/**
 * Decide one dirty patch, given the frame's remaining budget.
 *
 * @param cell         the cell this patch would be cut at
 * @param priceMs      expected inline cost for that cell (see cutPrice)
 * @param remainingMs  ms left in the frame's budget for this pass (can be negative)
 * @param inflight     far cuts currently running
 * @param cap          max far cuts allowed in flight
 * @param waitedMs     how long this patch has been marked dirty
 * @param starveMs     after this long a deferral turns into a forced cut (0 disables)
 * @param hasMesh      a previous mesh of this patch is on screen (so deferring is not a hole)
 * @returns 'worker' | 'inline' | 'defer' | 'force'
 *
 * Order matters: a worker costs the render thread a fraction of a millisecond no matter how big the
 * patch is, so it always wins when a thread is free. An inline cut is only taken when the *measured*
 * cost of this cell fits the rest of the frame. A patch whose cut does not fit is left marked - and
 * if it has been waiting longer than `starveMs`, it is cut anyway: a hole in the ground and a pan
 * that never settles are both worse than one late frame.
 */
export function decideCut({ cell = 1, priceMs = 0, remainingMs = 0, inflight = 0, cap = 0,
  waitedMs = 0, starveMs = 400, hasMesh = false } = {}) {
  if (inflight < cap) return 'worker';
  if (priceMs <= remainingMs) return 'inline';
  if (starveMs > 0 && waitedMs >= starveMs) return 'force';
  return 'defer';
}

/**
 * May this patch take a worker thread, even past the cap held back for chunk detail?
 *
 * The cap exists so a pan's detail chunks are never queued behind far terrain: a far patch holds a
 * thread for as long as it meshes, 30-50 ms at cell 1. But when the cap is already full and a thread
 * is idle anyway, the alternative to taking that thread is cutting on the render thread - which costs
 * the whole frame, and every other layer waiting in it. So the exception is priced: an *expensive*
 * cut may go past the cap, cheap ones stay inside it, because a cheap inline cut is what inline is
 * actually for.
 *
 * @param inflight   far cuts running now
 * @param cap        far cuts the pool policy allows at once
 * @param poolSize   threads in the pool
 * @param priceMs    expected cost of this cut (see cutPrice)
 * @param stealMs    a cut above this cost may use a reserved thread (0 = never)
 * @param workerFree at least one pool thread is not busy with anything
 * @param detailWaiting chunk detail meshes queued or running: what the reservation is for
 */
export function mayTakeThread({ inflight = 0, cap = 0, poolSize = 0, priceMs = 0, stealMs = 0,
  workerFree = false, detailWaiting = 0 } = {}) {
  if (!workerFree) return false;
  if (inflight < cap) return true;
  // The cap exists for chunk detail. If detail is waiting, the idle thread belongs to it - it will be
  // asked for a mesh within the frame. If nothing is waiting, the thread is idle either way.
  if (detailWaiting > 0 || stealMs <= 0 || inflight >= poolSize) return false;
  return priceMs > stealMs;
}
