(async () => {
  const r = __world.renderer, s = __world.scene, c = __world.camera;
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const row = (tag, n = 20) => {
    r.render(s, c);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.render(s, c);
    const ms = (performance.now() - t0) / n;
    const q = __world.state, g = __world.gridEst();
    const hist = {};
    for (const t of g.tiers) hist[q.shellCells[t] ?? t] = (hist[q.shellCells[t] ?? t] ?? 0) + 1;
    return `${tag} render=${ms.toFixed(2)}ms total=${q.verts} shellVerts=${q.shellVerts}` +
      ` estCols=${g.columns} liveMeshCols=${g.verts} costScale=${g.costScale.toFixed(2)}` +
      ` patchesByCell=${JSON.stringify(hist)} skinR=${q.skinRadius} detailR=${q.detailRadius}` +
      ` detailVerts=${q.detailVerts}`;
  };
  const out = [];
  for (const d of [300, 1500, 26000]) {
    __world.orbit(0.55, null, d); await sleep(9000); __world.tick(200);
    out.push(row(`dist ${d}`));
  }
  return out.join('\n');
})()
