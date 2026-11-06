// Does an inline packed cut ever reach past PATCH_REACH?
async function run() {
  const w = window.__world;
  const s0 = w.state;
  const [tcx, , tcz] = w.state.target;
  const settle = async (ms) => { const e = performance.now() + ms; while (performance.now() < e) { w.tick(2); await new Promise(r => setTimeout(r, 60)); } };
  await settle(6000);
  const t0 = performance.now(); let n = 0;
  while (performance.now() - t0 < 5000) {
    n++;
    w.orbit({ target: [tcx + 4 * n, 0, tcz + 12 * n], dist: 400, pitch: 6, yaw: 0 });
    w.tick(1);
    await new Promise(r => setTimeout(r, 90));
  }
  await settle(3000);
  const st = w.state;
  return { pw: w.settings.patchWorkers, wide: st.patchWide, outside: st.patchOutside,
    posted: st.patchPosted, dropped: st.patchDropped, jobs: st.shellJobs,
    patches: st.shellPatches ?? null, dirty: st.dirtyPatches ?? st.dirty, verts: st.verts, fps: st.fps };
}
return run();
