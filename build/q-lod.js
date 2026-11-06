'LOD4 ' + JSON.stringify([260, 420, 560, 1120].map((x) => {
  const hits = __world.pickStack(x, 400, 3).map((h) => ({
    dr: h.drawn, q: h.quad, p: h.point, s: h.shellState, nrm: h.nrm,
  }));
  return { x, hits };
}))
