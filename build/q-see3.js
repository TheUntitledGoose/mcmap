(async () => {
  __world.orbit(null, null, 200);
  for (let i = 0; i < 40; i++) { __world.tick(4, 16); await new Promise((r) => setTimeout(r, 120)); }
  const out = [];
  for (const [x, y] of [[120, 300], [400, 300], [640, 300], [900, 300], [1150, 300], [640, 150], [640, 620]]) {
    const hits = __world.pickStack(x, y, 4) || [];
    out.push({
      screen: [x, y],
      hits: hits.map((h) => {
        const p = h.point;
        return `${h.drawn}@${p ? `${p[0].toFixed(0)},${p[1].toFixed(0)},${p[2].toFixed(0)}` : '?'}${h.state ? ' ' + h.state : ''}${h.shellState ? ' shell:' + h.shellState : ''}`;
      }),
    });
  }
  return {
    dist: __world.state.dist, skinR: __world.state.skinRadius, detailR: __world.state.detailRadius,
    shellVerts: __world.state.shellVerts, ovVerts: __world.state.ovVerts,
    ovAt: __world.ovAt(2976, 2007), lod: __world.lodOf(2976, 2007), out,
  };
})()
