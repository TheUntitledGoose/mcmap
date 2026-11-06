(async () => {
  const r = __world.renderer, s = __world.scene, c = __world.camera;
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const row = (tag, n = 20) => {
    r.render(s, c);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.render(s, c);
    const ms = (performance.now() - t0) / n;
    const q = __world.state, g = __world.gridEst();
    return `${tag} render=${ms.toFixed(2)}ms total=${q.verts} detailVerts=${q.detailVerts}` +
      ` shellVerts=${q.shellVerts} estVerts=${g.estVerts} costScale=${g.costScale.toFixed(2)}` +
      ` skirt=${g.skirtScale} vpc=${g.vpc} skinR=${q.skinRadius} detailR=${q.detailRadius}` +
      ` err=${q.frameError}`;
  };
  const out = [];
  for (const d of [40, 300, 1500, 26000]) {
    __world.orbit(0.55, null, d); await sleep(9000); __world.tick(250);
    out.push(row(`dist ${d}`));
  }
  return out.join('\n');
})()
