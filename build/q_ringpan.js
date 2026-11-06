// Pan, then hold: the frame after this is what the two ring-marking policies look like side by side.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(9000);
  const [x0, y0, z0] = w.state.target;
  for (let i = 1; i <= 4; i++) { w.go(x0 + 20 * i, y0, z0 + 20 * i); await sleep(300); }
  await sleep(4000); w.tick(2);
  const s = w.state;
  return JSON.stringify({ scan: w.settings.ringScan, ring: s.detailRadius, held: s.chunks,
    stuck: s.ringStuck, dirty: s.dirty, verts: s.verts, fps: +s.fps.toFixed(1) });
})()
