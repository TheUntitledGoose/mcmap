'LOD6 ' + JSON.stringify([[180, 230], [500, 210], [900, 200], [1240, 250], [300, 620], [1050, 700]].map(([x, y]) => {
  const h = __world.pickStack(x, y, 1)[0] || null;
  if (!h) return { x, y, none: true };
  const lod = __world.lodOf(h.point[0], h.point[2]), ov = __world.ovAt(h.point[0], h.point[2]);
  return {
    x, y, dr: h.drawn, quad: h.quad, p: h.point.map((v) => +v.toFixed(1)),
    painted: h.shellState ?? h.state, nrm: h.nrm, lod,
    ov: ov && { h: ov.h, s: ov.state, covered: ov.covered },
    d: Math.round(Math.hypot(h.point[0] - __world.state.target[0], h.point[2] - __world.state.target[2])),
  };
}))
