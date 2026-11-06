(() => {
  // Zoom is a first-class LOD input now: pulling in must refine the far grid and the world layer has
  // to get out of the way of the square the skin covers. Report both at each stop.
  const one = (tag) => {
    const q = __world.state, d = __world.ovDiag();
    const hits = [[400, 420], [900, 620], [640, 250]].map(([x, y]) => {
      const h = __world.pickStack(x, y, 1)[0];
      if (!h) return 'SKY';
      const near = Math.round(Math.hypot(h.point[0] - q.target[0], h.point[2] - q.target[2]));
      return `${h.drawn}@${near}m`;
    });
    return `${tag} ${JSON.stringify({ dist: Math.round(q.dist), skinR: q.skinRadius,
      tiers: q.shellTiers, shV: q.shellVerts, shH: q.shellHeld, ovC: q.ovCells, ovS: q.ovSkipped,
      stamp: d.covStamp, hits, verts: q.verts, fps: Math.round(q.fps), err: q.frameError })}`;
  };
  __world.orbit(0.6, 1.05, 26000);
  __world.tick(80);
  const a = one('whole');
  __world.orbit(0.6, 0.35, 350);
  __world.tick(80);
  const b = one('after-zoom-in');
  return 'LOD11 ' + a + ' | ' + b;
})()
