(() => {
  // Why is the whole-dimension layer painting 50 m from the camera when the per-chunk skin covers
  // that ground? Attribute the hit, then ask the overview what it thinks about that cell.
  __world.orbit(0.6, 0.06, 120);
  __world.tick(60);
  const q = __world.state;
  const out = [];
  for (const [x, y] of [[400, 420], [900, 620], [640, 300], [300, 500]]) {
    const h = __world.pickStack(x, y, 1)[0];
    if (!h) { out.push({ x, y, hit: 'SKY' }); continue; }
    const cx = Math.floor(h.point[0] / 16), cz = Math.floor(h.point[2] / 16);
    out.push({ x, y, drawn: h.drawn, at: [Math.round(h.point[0]), Math.round(h.point[1]), Math.round(h.point[2])],
      dist: Math.round(Math.hypot(h.point[0] - q.target[0], h.point[2] - q.target[2])),
      lod: __world.lodOf(h.point[0], h.point[2]).cell,
      ov: __world.ovAt(h.point[0], h.point[2]) });
  }
  return 'LOD9 ' + JSON.stringify({ out, diag: __world.ovDiag(), shH: q.shellHeld, skinR: q.skinRadius });
})()
