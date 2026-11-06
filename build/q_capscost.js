(() => {
  const w = window.__world, l = w.lodDiag(), st = w.state, g = w.gridEst();
  return { caps: w.settings.caps, capDrop: w.settings.capDrop, lodOn: !!w.settings.lod,
    lodVerts: l.verts, lodHeld: l.held, lodDrawn: l.drawn, bad: l.policyBad, rung: l.rung,
    shellVerts: st.shellVerts, gridCaps: g.caps, total: st.verts, fps: +st.fps.toFixed(1) };
})()
