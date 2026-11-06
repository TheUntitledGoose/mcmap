// Cost of the sharp ring at the user's framing: verts, RAM, fill time.
return (async () => {
  const w = window.__world, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(14000);
  const a = w.state, r0 = a.detailRadius;
  const [x0, y0, z0] = a.target;
  w.go(x0 + 400, y0, z0 + 200);
  let fill = -1;
  for (let t = 0; t <= 20000; t += 500) {
    await sleep(500); w.tick(2);
    const s = w.state;
    if (fill < 0 && s.dirty === 0 && s.meshJobs === 0) fill = t;
  }
  const b = w.state;
  const per = b.chunks ? Math.round(b.bytesHeld / b.chunks / 1024) : 0;
  return JSON.stringify({ ring: r0, settled: { dm: a.detailMeshes, dv: +(a.detailVerts/1e6).toFixed(1),
    verts: +(a.verts/1e6).toFixed(1), ch: a.chunks, mb: +(a.bytesHeld/1048576).toFixed(0),
    parkMB: a.meshCacheMB, fps: +a.fps.toFixed(1) },
    after: { dm: b.detailMeshes, dv: +(b.detailVerts/1e6).toFixed(1), verts: +(b.verts/1e6).toFixed(1),
      ch: b.chunks, mb: +(b.bytesHeld/1048576).toFixed(0), kbPerChunk: per, parkMB: b.meshCacheMB,
      fps: +b.fps.toFixed(1) }, fillMs: fill }, null, 1);
})()
