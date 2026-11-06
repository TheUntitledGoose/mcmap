// Who paints the ground at this framing, and how much does each layer cost?
return (async () => {
  const w = window.__world, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(14000);
  const s = w.state, g = w.gridEst(), l = w.lodDiag();
  const hist = {};
  for (const t of g.tiers) hist[t] = (hist[t] || 0) + 1;
  return JSON.stringify({
    dist: s.dist, ring: s.detailRadius, payR: s.payloadRadius, verts: s.verts,
    detailMeshes: s.detailMeshes, detailVerts: s.detailVerts,
    grid: { patches: g.tiers.length, tiers: hist, verts: g.verts, estVerts: g.estVerts,
      costScale: +g.costScale.toFixed(2), cellPx: +g.cellPx.toFixed(2), budget: g.budget,
      caps: g.caps, cutMs: g.cutMs },
    lod: { held: l.held, drawn: l.drawn, cells: l.cells, cov: l.cov, covDetail: l.covDetail, verts: l.verts },
    overviewOn: s.overviewActive ?? null, skinOn: s.skinOn ?? null,
  }, null, 1);
})()
