// Does the LOD quality slider actually clamp both coarse layers?
// Print what the page parsed, then what each layer did about it.
(() => {
  const w = window.__world, S = w.settings, st = w.state, d = w.lodDiag(), g = w.gridEst();
  return {
    quality: S.lodQuality, maxCell: S.lodMaxCell, cellPx: S.lodCellPx, maxPx: S.lodCellMaxPx,
    caps: S.caps, capDrop: S.capDrop,
    held: d.held, drawn: d.drawn, bad: d.policyBad, rung: d.rung, lodVerts: d.verts,
    gridTiers: [...new Set(g.tiers)].sort((a, b) => a - b), gridVerts: g.verts, gridCaps: g.caps,
    shellVerts: st.shellVerts, ovOn: st.ovOn,
    fps: +st.fps.toFixed(1), verts: st.verts,
  };
})()
