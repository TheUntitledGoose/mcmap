(() => {
  const sleep = (ms) => new Promise((x) => { setTimeout(x, ms); });
  const out = [];
  const go = (d) => new Promise((res) => {
    __world.orbit(0.55, 0.05, d);
    setTimeout(() => { __world.tick(150); const g = __world.gridEst(), q = __world.state;
      out.push(`d=${d} cost=${g.costScale} boost=${g.floorBoost} vpc=${g.vpc} cols=${g.columns} est=${g.estVerts} budget=${g.budget} px=${g.cellPx.toFixed(2)} shellVerts=${q.shellVerts} render=${__world.renderMs()}ms`);
      res(); }, 8000);
  });
  return (async () => { for (const d of [40, 300, 1500, 26000]) await go(d); return out.join('\n'); })();
})()
