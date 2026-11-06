(async () => {
  const r = __world.renderer, s = __world.scene, c = __world.camera;
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const row = (tag, n = 25) => {
    r.render(s, c);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.render(s, c);
    const ms = (performance.now() - t0) / n;
    const q = __world.state;
    return `${tag} render=${ms.toFixed(2)}ms detailR=${q.detailRadius} detailMeshes=${q.detailMeshes}` +
      ` detailVerts=${q.detailVerts} demoted=${q.demoted} shellVerts=${q.shellVerts}` +
      ` total=${q.verts} costScale=${q.farCostScale} lod="${q.shellTiers}" err=${q.frameError}`;
  };
  const out = [];
  for (const d of [300, 1500, 26000]) {
    __world.orbit(0.55, null, d); await sleep(9000); __world.tick(150);
    out.push(row(`dist ${d}`));
  }
  return out.join('\n');
})()
