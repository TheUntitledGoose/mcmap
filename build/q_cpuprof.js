// Self-time profile of a pan: what the render thread actually does while the map is dragged.
async function run() {
  const w = window.__world;
  // leave patchWorkers at the shipped default: a profile of a setting nobody runs is a chart
  w.settings.profdur = 6;
  const s0 = w.state;
  const [tcx, , tcz] = w.state.target;
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 4000) {
    n++;
    w.orbit({ target: [tcx + 4 * n, 0, tcz + 12 * n], dist: 400, pitch: 6, yaw: 0 });
    w.tick(1);
    await new Promise(r => setTimeout(r, 90));
  }
  const st = w.state;
  return { frames: st.frames, chunks: st.chunks, verts: st.verts, prof: w.prof() };
}
return run();
