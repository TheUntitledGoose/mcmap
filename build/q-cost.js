(async () => {
  const r = __world.renderer, s = __world.scene, c = __world.camera;
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  __world.orbit(0.55, null, 26000); await sleep(14000); __world.tick(150);
  r.render(s, c);
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) r.render(s, c);
  const ms = (performance.now() - t0) / 30;
  const q = __world.state;
  return JSON.stringify({ detailLod: q.detailLod, dist: Math.round(q.dist), detailR: q.detailRadius,
    detailMeshes: q.detailMeshes, detailVerts: q.detailVerts, demoted: q.demoted,
    shellVerts: q.shellVerts, ovVerts: q.ovVerts, total: q.verts, costScale: q.farCostScale,
    lod: q.shellTiers, renderMs: +ms.toFixed(2), err: q.frameError });
})()
