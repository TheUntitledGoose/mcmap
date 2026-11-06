// Why does the baked far layer take a while to come back after a pan?
// Jump the view, then watch the LOD pipeline drain: what is asked for, in flight, held, drawn.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const d = () => {
    const g = w.lodDiag(), s = w.state;
    return {
      wanted: g.wanted, held: g.held, drawn: g.drawn, gaps: g.gaps, inflight: g.inflight,
      loaded: g.loaded, dropped: g.dropped, lodVerts: g.verts, rung: g.rung,
      shellVerts: s.shellVerts, patches: s.shellPatches, dirtyPatches: w.gridEst().dirty,
      cuts: w.gridEst().cuts, fps: +s.fps.toFixed(1), verts: s.verts,
    };
  };
  const out = [];
  await sleep(1500); w.tick(20);
  out.push({ t: 0, note: 'settled', ...d() });
  const [x0, y0, z0] = w.state.target;
  w.go(x0 + 900, y0, z0 - 500);               // one pan, far away, 1030 blocks
  for (let i = 1; i <= 16; i++) {
    await sleep(500);
    w.tick(6);
    out.push({ t: i * 500, ...d() });
  }
  return JSON.stringify(out, null, 1);
})()
