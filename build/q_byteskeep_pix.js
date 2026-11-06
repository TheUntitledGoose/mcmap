// Correctness A/B for keeping parked triangles across a payload eviction: pan away and back, let the
// scene settle, and report both the counters and a screenshot. If a parked set were installed against
// a border it was not cut for, the pixels would differ - missing walls at chunk seams.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [x0, y0, z0] = w.state.target;
  for (let i = 1; i <= 8; i++) { w.go(x0 + 400 * i / 8, y0, z0); await sleep(200); w.tick(8); }
  for (let i = 1; i <= 8; i++) { w.go(x0 - 400 * i / 8, y0, z0); await sleep(200); w.tick(8); }
  await sleep(9000); w.tick(30);
  const s = w.state;
  return {
    bytesKeep: s.bytesKeep, meshKeyOn: s.meshKeyOn, meshBuilds: s.meshBuilds,
    reused: s.meshReused, unchanged: s.meshUnchanged, parked: s.meshCachedChunks,
    ghost: s.meshBytesGhost, parkMB: s.meshCacheMB,
    parkThenBuild: s.parkThenBuild, meshMs: s.meshMs, verts: s.verts, chunks: s.chunks,
    detail: s.detailRadius, dirty: s.dirty, fps: +s.fps.toFixed(1),
  };
})();
