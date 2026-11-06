(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mean = (v) => v ? v[0].map((_, k) => Math.round(v.reduce((a, c) => a + c[k], 0) / 3 * 255)) : null;
  const rows = [];
  for (const d of [200, 1200, 26000]) {
    __world.orbit(null, null, d);
    for (let i = 0; i < 40; i++) { __world.tick(1, 16); await sleep(6); }
    await sleep(1200);
    const s = __world.state;
    const hits = [];
    for (let sx = 500; sx <= 860; sx += 90) for (let sy = 320; sy <= 600; sy += 90) {
      const st = __world.pickStack(sx, sy, 2);
      if (!st || !st.length) continue;
      const h = st[0], p = h.point;
      hits.push(`${h.drawn}@${p[0] | 0},${p[1] | 0},${p[2] | 0}:${(h.shellState ?? h.state ?? '?').split('|')[0].split(':')[1]}:${mean(h.vcol)}`);
    }
    const od = __world.ovDiag();
    rows.push({ dist: s.dist, verts: s.verts, detailVerts: s.detailVerts, shellVerts: s.shellVerts,
      ovVerts: s.ovVerts, ovCells: s.ovCells, ovReady: s.ovReady, render: s.gpuMs, hits,
      ov: { cell: od.cell, bands: od.bands, stale: od.stale } });
  }
  return rows;
})()
