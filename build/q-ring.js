(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  for (const d of [300, 600]) {
    __world.orbit(null, null, d);
    for (let i = 0; i < 50; i++) { __world.tick(1, 16); await sleep(6); }
    await sleep(1500);
    const cy = 430, cx = 660;                 // through the orbit target, horizontally
    const groups = {}, samples = [];
    for (let sx = cx - 420; sx <= cx + 420; sx += 30) {
      const st = __world.pickStack(sx, cy, 2);
      if (!st || !st.length) continue;
      const h = st[0], p = h.point;
      const rgb = __world.pick(sx, cy);       // renders, then reads the one device pixel
      const name = h.drawn;
      const g = (groups[name] = groups[name] || { n: 0, sum: [0, 0, 0], min: [255, 255, 255], max: [0, 0, 0] });
      g.n++;
      for (let k = 0; k < 3; k++) {
        g.sum[k] += rgb[k]; g.min[k] = Math.min(g.min[k], rgb[k]); g.max[k] = Math.max(g.max[k], rgb[k]);
      }
      samples.push(`${sx}:${name}:${(h.shellState ?? h.state ?? '?').split('|')[0].split(':')[1]}` +
        `:${rgb.join(',')}`);
    }
    const meanOf = (g) => g.sum.map((v) => Math.round(v / g.n));
    rows.push({
      dist: __world.state.dist, detailRadius: __world.state.detailRadius,
      detail: groups.detail && meanOf(groups.detail), shell: groups.shell && meanOf(groups.shell),
      overview: groups.overview && meanOf(groups.overview),
      detailN: groups.detail && groups.detail.n, shellN: groups.shell && groups.shell.n,
      dMin: groups.detail && groups.detail.min, dMax: groups.detail && groups.detail.max,
      sMin: groups.shell && groups.shell.min, sMax: groups.shell && groups.shell.max,
      samples,
    });
  }
  return rows;
})()
