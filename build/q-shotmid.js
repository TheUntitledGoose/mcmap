(async () => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  __world.orbit(0.5, 0.32, 300); await sleep(10000); __world.tick(120);
  const q = __world.state, g = __world.gridEst();
  return JSON.stringify({budget: __world.settings.vertBudget, costScale: +g.costScale.toFixed(2),
    skirt: g.skirtScale, shellVerts: q.shellVerts, detailVerts: q.detailVerts, estVerts: g.estVerts,
    cells: q.shellCells, tiers: q.shellTiersLive.length, err: q.frameError});
})()
