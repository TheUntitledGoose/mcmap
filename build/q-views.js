(() => {
  // Three views the user walks through: whole world, eye level, and a mid pull-back. For each:
  // what painted the middle of the frame, how much geometry is live, and what the tier ladder is.
  const one = (tag, yaw, pitch, dist) => {
    __world.orbit(yaw, pitch, dist);
    __world.tick(60);
    const q = __world.state;
    const hits = [[640, 200], [400, 420], [900, 620]].map(([x, y]) => {
      const h = __world.pickStack(x, y, 1)[0];
      if (!h) return 'SKY';
      const d = Math.round(Math.hypot(h.point[0] - q.target[0], h.point[2] - q.target[2]));
      const c = __world.lodOf(Math.floor(h.point[0] / 16), Math.floor(h.point[2] / 16));
      return `${h.drawn}@${d}m cell${c.cell}`;
    });
    return `${tag} ${JSON.stringify({ hits, shV: q.shellVerts, shH: q.shellHeld, ovC: q.ovCells,
      ovS: q.ovSkipped, verts: q.verts, drawn: q.drawn, fps: Math.round(q.fps), near: q.near,
      far: q.far, err: q.frameError })}`;
  };
  return 'LOD8 ' + [one('whole', 0.6, 1.05, 26000), one('eyelevel', 0.6, 0.06, 120),
    one('mid', 0.6, 0.35, 900)].join(' | ');
})()
