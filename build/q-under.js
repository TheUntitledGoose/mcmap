(() => {
  const W = innerWidth, H = innerHeight, out = [];
  const pts = [[6,4],[4,4],[8,4],[2,5],[10,5],[6,3],[6,7],[6,2]];
  for (const [ix, iy] of pts) {
    const h = __world.pickStack(Math.round(W * ix / 12), Math.round(H * iy / 10), 2);
    out.push(h && h.length ? h.map((x) => x.drawn + '@' + x.point[1].toFixed(0) + (x.state ? ' ' + x.state.split(':')[1].slice(0, 16) : (x.shellState ? ' ~' + x.shellState.split(':')[1].slice(0, 14) : ''))) : 'miss');
  }
  const s = __world.state;
  return JSON.stringify({
    out,
    st: { detailVerts: s.detailVerts, shellVerts: s.shellVerts, lodVerts: s.lodVerts, ovVerts: s.ovVerts,
          buried: s.cullBuried, dark: s.cullDark, meshes: s.detailMeshes, fps: +s.fps.toFixed(1),
          held: s.chunksHeld, lod: __world.lodDiag().drawn, cam: s.cam ?? s.eye ?? null },
  });
})()
