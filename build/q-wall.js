(() => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  return (async () => {
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(12000); __world.tick(250);
    const out = [];
    for (const [x, y] of [[390, 200], [420, 250], [470, 130], [500, 300]]) {
      const h = __world.pickStack(x, y, 2)[0];
      if (!h) { out.push(`[${x},${y}] SKY`); continue; }
      const p = h.point, cx = Math.floor(p[0] / 16), cz = Math.floor(p[2] / 16);
      const l = __world.lodOf(p[0], p[2]);
      const sh = __world.shellAt(cx, cz);
      let tops = 'no-shell';
      if (sh) { let mn = 999, mx = -999; for (let i = 0; i < 256; i++) { const v = sh.height[i] - 2048; mn = Math.min(mn, v); mx = Math.max(mx, v); } tops = `shellTop ${mn}..${mx}`; }
      out.push(`[${x},${y}] ${h.drawn} quad=${h.quad} at(${p.join(',')}) painted=${h.shellState} voxel=${h.state} lod(cell=${l.cell},tier=${l.tier}) ${tops}`);
    }
    const q = __world.state;
    out.push('state ' + JSON.stringify({ shellVerts: q.shellVerts, ovVerts: q.ovVerts, detailVerts: q.detailVerts, ovCells: q.ovCells, ovSkipped: q.ovSkipped, cost: q.farCostScale, boost: q.farFloorBoost }));
    return out.join('\n');
  })();
})()
