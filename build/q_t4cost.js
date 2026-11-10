// The frame bill of a wider full-resolution square, measured once the scene has SETTLED. A fps readout
// taken 4 s after a radius change measures the meshing churn, not the frame.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 3000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = { sweep: [] };
w.setTimePlay(0);
await settle(1500);

const quiet = async (maxMs = 30000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) {
    await sleep(100); w.tick(2);
    const s = w.state;
    if (!s.dirty && !s.queued && !s.inflight && s.ringStuck[0] === 0 && s.meshQueued === 0) break;
  }
  return { waitedMs: Math.round(performance.now() - t0), dirty: w.state.dirty,
    queued: w.state.queued, inflight: w.state.inflight, meshQueued: w.state.meshQueued,
    ringStuck: w.state.ringStuck };
};

for (const radius of [8, 12, 16, 24]) {
  w.set('detail', radius);
  await settle(2500);
  const q = await quiet();
  await settle(2500);
  const s = w.state;
  out.sweep.push({ radiusChunks: radius, blockSquare: `${(2 * s.detailRadius + 1) * 16} m`,
    detailRadius: s.detailRadius, detailMeshes: s.detailMeshes, chunks: s.chunks,
    verts: s.verts, detailVerts: s.detailVerts, shellVerts: s.shellVerts, lodVerts: s.lodVerts,
    fps: Math.round(s.fps), frameMs: +(1000 / Math.max(1, s.fps)).toFixed(1), meshMs: s.meshMs,
    workerMs: w.hist().workerPatchTotalMs, tris: s.tris, quiet: q });
}
out.dist = w.state.dist;
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
