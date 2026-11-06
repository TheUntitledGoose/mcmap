(() => {
  const W = innerWidth, H = innerHeight;
  const rows = []; const counts = {}; let miss = 0;
  for (let iy = 2; iy < 9; iy++) {
    const y = Math.round(H * iy / 10); let line = '';
    for (let ix = 1; ix < 13; ix++) {
      const x = Math.round(W * ix / 13);
      const h = __world.pickStack(x, y, 1)[0];
      const k = h ? h.drawn : 'MISS';
      counts[k] = (counts[k] || 0) + 1; if (!h) miss++;
      line += ({ detail: 'D', shell: 'S', overview: 'O', lod: 'L', MISS: '.' })[k] || '?';
    }
    rows.push(line);
  }
  const d = __world.lodDiag(), s = __world.state;
  return JSON.stringify({
    rows, counts, miss,
    lod: { held: d.held, drawn: d.drawn, wanted: d.wanted, gaps: d.gaps, refused: d.refused,
           shade: d.shadeDiff, bad: d.policyBad, clipOn: d.clipOn, clip: d.clip },
    st: { ovOn: s.ovOn, verts: s.verts, lodVerts: s.lodVerts, patches: s.patches,
          dirty: s.dirtyPatches, held: s.chunksHeld, shells: s.shellPatches, fps: +s.fps.toFixed(1) },
    grid: __world.gridEst(), prof: __world.prof(),
  });
})()
