window.__clipProbe = (tag) => {
  const pts = [];
  for (const [fx, fy] of [[0.5,0.5],[0.2,0.6],[0.8,0.6],[0.35,0.75],[0.65,0.75],[0.5,0.9],[0.08,0.5],[0.92,0.5]]) {
    const hits = __world.pickStack(Math.round(innerWidth * fx), Math.round(innerHeight * fy), 3) || [];
    pts.push(hits.length ? (hits[0].drawn ?? '?') + (hits[0].lodTile ? ':' + hits[0].lodTile : '') : 'miss');
  }
  const d = __world.lodDiag();
  const s = __world.state;
  return JSON.stringify({ tag, pts, clipOn: d.clipOn, clip: d.clip, held: d.held, drawn: d.drawn,
    gaps: d.gaps, verts: s.verts, shell: s.shellVerts, lod: s.lodVerts, patches: s.shellPatches, fps: +s.fps.toFixed(1) });
};
'clip probe ready';
