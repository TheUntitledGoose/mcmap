// shared/pool.mjs - how the mesh thread pool is split between the two things that use it.
//
// Two workloads share one pool:
//   chunk detail meshes   26 ms each, posted from the chunk dirty queue - the only thing that can
//                         paint the ground under the camera;
//   far shell patch cuts  20-25 ms each, posted from the frame loop, so at most `patchCap()` of them
//                         can ever be in flight.
//
// The bug this file exists to prevent: the pool used to hold back `min(patchCap, pool-1)` threads for
// cuts whenever `dirtyPatches` was non-empty - 7 of 8 threads on an 8-thread pool with cap 6. Cuts
// cannot fill that reservation, so chunk detail ran on one thread and took 13+ s to mesh what a pan
// dirtied ("detailed chunks are just not loading after panning around"). A reservation has to be
// sized by what the reserved job can *take*, not by how many jobs are waiting.

/**
 * How many pool threads a chunk detail job must leave free for far patch cuts.
 *
 * @param patchCap       max far cuts the page will have in flight at once
 * @param dirtyPatches   far patch keys whose cut has not been posted yet
 * @param patchInflight  far cuts already running
 * @param poolSize       threads in the pool
 * @param keep           threads held back when cuts are still unserved (default 2)
 * @returns threads chunk jobs may not take; 0 means the cut queue is saturated or empty
 */
export function cutReserve({ patchCap = 0, dirtyPatches = 0, patchInflight = 0, poolSize = 0,
  keep = 2 } = {}) {
  const n = Math.max(0, poolSize | 0);
  if (!n) return 0;
  // A patch key leaves `dirtyPatches` when its cut is posted, so the dirty set counts cuts that have
  // not started, and `patchInflight` counts the ones that have. The cuts still worth waiting for are
  // therefore the ones that could be posted right now: wanted, and under the in-flight ceiling.
  const room = Math.max(0, Math.min(Math.max(0, patchCap | 0) - Math.max(0, patchInflight | 0),
    Math.max(0, dirtyPatches | 0)));
  return room > 0 ? Math.min(Math.max(0, keep | 0), room, n - 1) : 0;
}

/**
 * How many far patch cuts may run at once. Never lets chunk detail lose the pool: `keepForChunks`
 * threads stay for chunk jobs, which is what keeps the ground under the camera filling in.
 */
export function patchThreadCap({ poolSize, want = 0, keepForChunks = 2 } = {}) {
  return Math.max(0, Math.min(want | 0, (poolSize | 0) - Math.max(1, keepForChunks)));
}
