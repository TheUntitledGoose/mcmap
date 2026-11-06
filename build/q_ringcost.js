// What does a bigger sharp ring buy, and what does it cost? One page, one radius.
return (async () => {
  const w = window.__world, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => { const s = w.state; return { ch: s.chunks, dm: s.detailMeshes, dv: s.detailVerts,
    verts: s.verts, fps: +s.fps.toFixed(1), dirty: s.dirty, dr: s.detailRadius, pr: s.payloadRadius,
    res: +w.res().scale.toFixed(2) }; };
  await sleep(14000);
  const a = snap();
  const [x0, y0, z0] = w.state.target;
  w.go(x0 + 320, y0, z0 + 160);
  let fillMs = -1;
  for (let t = 0; t <= 24000; t += 500) {
    await sleep(500); w.tick(2);
    if (fillMs < 0 && w.state.dirty === 0 && w.state.detailMeshes > 200) fillMs = t;
  }
  const b = snap();
  return JSON.stringify({ radius: w.state.detailCeiling, settled: a, afterPan: b, fillMs }, null, 1);
})()
