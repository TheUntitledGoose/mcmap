(() => {
  const w = window.__world;
  const s = w.settings;
  const st = w.state;
  const g = w.gridEst();
  const l = w.lodDiag();
  const seen = {};
  let miss = 0;
  const rows = [0.15, 0.3, 0.45, 0.6, 0.75].map((f) => Math.round(innerHeight * f));
  const colsx = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.round(innerWidth * f));
  for (const sy of rows) {
    for (const sx of colsx) {
      const hits = w.pickStack(sx, sy, 1);
      const h = hits && hits.length ? hits[hits.length - 1] : null;
      if (!h) { miss++; continue; }
      seen[h.drawn] = (seen[h.drawn] || 0) + 1;
    }
  }
  const [tx, , tz] = st.target;
  const under = w.lodAt(tx, tz);
  const far = w.lodAt(tx + 3000, tz + 3000);
  return {
    href: location.href,
    far: { caps: s.caps, capDrop: s.capDrop, quality: s.lodQuality, maxCell: s.lodMaxCell,
      cellPx: s.lodCellPx, maxPx: s.lodCellMaxPx, groundFar: s.groundFar, lod: s.lod, shell: s.shellOn },
    scene: { fps: +st.fps.toFixed(1), verts: st.verts, detail: st.detailMeshes, detailVerts: st.detailVerts,
      retired: st.retired, shellVerts: st.shellVerts },
    grid: { patches: g.patches, caps: g.caps, cutMs: g.cutMs, cuts: g.cuts, dirty: g.dirty,
      costScale: g.costScale, vpc: g.vpc },
    lod: { held: l.held, drawn: l.drawn, gaps: l.gaps, refused: l.refused, bad: l.policyBad,
      rung: l.rung, cov: l.cov, covDetail: l.covDetail, covHeld: l.covHeld, clip: l.clipOn,
      cells: l.cells, shade: l.shadeDiff, verts: l.verts },
    tiles: { under: { held: under.held, cell: under.cell, drawn: under.drawn, verts: under.verts },
      far: { held: far.held, cell: far.cell, drawn: far.drawn, verts: far.verts } },
    paint: Object.assign({}, seen, { miss }),
  };
})()
