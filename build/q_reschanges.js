// How many times did the picture get reallocated, and how much is that costing?
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(6000);
  const a = w.res();
  const [x0, y0, z0] = w.state.target;
  for (let i = 1; i <= 12; i++) { w.go(x0 + 60 * i, y0, z0 + 25 * i); await sleep(260); }
  await sleep(4000);
  const b = w.res(), s = w.state, p = w.prof();
  return JSON.stringify({ autoOn: a.autoOn, timerExt: a.gpuTimer, changesBefore: a.changes,
    changesAfter: b.changes, scaleBefore: +a.scale.toFixed(3), scaleAfter: +b.scale.toFixed(3),
    gpuMs: +b.gpuMs.toFixed(1), cpuRenderMs: +b.cpuRenderMs.toFixed(2), fps: +s.fps.toFixed(1), prof: p }, null, 1);
})()
