// Is the ring limited by the network, the meshing threads, or the queue?
return (async () => {
  const w = window.__world, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(12000);
  const [x0, y0, z0] = w.state.target;
  w.go(x0 + 400, y0, z0 + 200);
  const rows = [];
  for (let t = 0; t <= 16000; t += 1000) {
    await sleep(1000); w.tick(2);
    const s = w.state;
    rows.push({ t, ch: s.chunks, infl: s.inflight, q: s.queued, miss: s.missing, dirty: s.dirty,
      dm: s.detailMeshes, mb: +(s.bytesHeld / 1048576).toFixed(1), fps: +s.fps.toFixed(1) });
  }
  return JSON.stringify({ ring: w.state.detailRadius, payR: w.state.payloadRadius, cap: w.state.storeCap ?? null, rows }, null, 1);
})()
