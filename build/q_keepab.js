// In-page A/B of keeping parked triangles across a payload eviction: one page, one camera path, the
// only thing that changes is S.bytesKeep. Each pass is a 400-block pan out and straight back, with the
// drag sampled (fps is measured during the drag, not after it, or the number is just settling).
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => {
    const s = w.state;
    return { b: s.meshBuilds, re: s.meshReused, same: s.meshUnchanged, ptb: s.parkThenBuild,
      parked: s.meshCachedChunks, parkMB: s.meshCacheMB, dirty: s.dirty, fps: s.fps };
  };
  const pass = async (keep) => {
    w.settings.bytesKeep = keep;
    await sleep(2500); w.tick(20);            // let the byte cache react to the switch
    const a = snap();
    const [x0, y0, z0] = w.state.target;
    const fps = [];
    for (const d of [1, -1]) {
      for (let i = 1; i <= 8; i++) {
        w.go(x0 + d * 400 * i / 8, y0, z0);
        await sleep(200); w.tick(8);
        fps.push(w.state.fps);
      }
    }
    const p = w.prof();               // buckets while it is still dragging, not after it settles
    await sleep(4000); w.tick(20);
    const b = snap();
    return { label: `keep ${keep}`,
      drag: `builds ${b.b - a.b} reused ${b.re - a.re} same ${b.same - a.same} thenBuild ${b.ptb - a.ptb}`,
      fps: `min ${Math.min(...fps).toFixed(1)} mean ${(fps.reduce((s, v) => s + v, 0) / fps.length).toFixed(1)}`,
      dragMs: `mesh ${(+p.mesh).toFixed(1)} demote ${(+p.demote).toFixed(1)} shell ${(+p.shell).toFixed(1)} view ${(+p.view).toFixed(1)} render ${(+p.render).toFixed(1)} total ${(+p.total ?? p.view + p.mesh + p.shell + p.ov + p.refill + p.demote + p.render).toFixed(1)}`,
      cache: `parked ${b.parked} parkMB ${b.parkMB} dirtyEnd ${b.dirty}` };
  };
  await sleep(1500); w.tick(15);
  const order = [0, 1, 0, 1, 1, 0];   // alternating, so drift in either direction shows up as drift, not as the setting
  const out = [];
  for (const k of order) out.push(await pass(k));
  return out;
})();
