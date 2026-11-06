// Does the detail layer refill after a pan, and how long does that take? Real frames, w.go() moves,
// like build/q_panfps.js: __world.tick() blocks the stack and no fetch resolves, which reports a calm
// world that was never moving.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = () => { const s = w.state; return { meshed: s.meshed, dirty: s.dirty, verts: s.verts,
    shellVerts: s.shellVerts, pdirty: s.dirtyPatches ?? null, held: s.chunks, inflight: s.inflight,
    fps: +s.fps.toFixed(1) }; };
  await sleep(6000);
  const before = row();
  const [x0, y0, z0] = w.state.target;
  for (let i = 1; i <= 12; i++) { w.go(x0 + 60 * i, y0, z0 + 25 * i); await sleep(260); }
  const after = row();
  const trail = [];
  for (let t = 1; t <= 10; t++) { await sleep(1500); trail.push({ t: t * 1500, ...row() }); }
  const s = w.state;
  return JSON.stringify({ pw: w.settings.patchWorkers, workers: s.workers, ready: s.workerReady,
    before, after, trail: trail.filter((r, i) => i % 2 === 0) }, null, 1);
})()
