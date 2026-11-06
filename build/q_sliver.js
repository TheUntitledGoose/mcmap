// What the user sees: how big is the sharp region, and what would a bigger one cost?
return (async () => {
  const w = window.__world, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(12000);
  const s = w.state, r = w.res();
  const st = (w.stateQuads ? null : null);
  return JSON.stringify({
    href: location.href, dist: s.dist, verts: s.verts, tris: s.tris, chunks: s.chunks,
    dirty: s.dirty, fps: +s.fps.toFixed(1),
    detailRadius: s.detailRadius, detailCeiling: s.detailCeiling, payloadRadius: s.payloadRadius,
    detailPx: s.detailPx, detailLod: s.detailLod, detailMeshes: s.detailMeshes,
    detailVerts: s.detailVerts, demoted: s.demoted, dirtyPatches: s.dirtyPatches,
    bytesHeld: s.bytesHeld, resScale: +r.scale.toFixed(2), changes: r.changes,
    cells: w.lodDiag ? w.lodDiag().cells : null, cellPx: s.cellPx,
  }, null, 1);
})()
