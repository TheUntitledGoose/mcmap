// A drag, measured the way a drag feels: real frames, no manual ticking.
// Samples fps and the per-frame CPU buckets while the view slides, then again while it rests.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (note) => {
    const s = w.state, p = w.prof(), g = w.gridEst();
    return { note, fps: +s.fps.toFixed(1), verts: s.verts, shellVerts: s.shellVerts,
      prof: p, cuts: g.cuts, cutMs: g.cutMs, dirty: g.dirty, patches: s.shellPatches,
      shellMs: s.shellMs, shellMsMax: s.shellMsMax, shellJobs: s.shellJobs ?? null,
      patch: [g.jobs ?? -1, g.posted ?? -1, g.dropped ?? -1, g.outside ?? -1],
      dirtyChunks: s.dirty, meshed: s.meshed, meshMs: s.meshMs };
  };
  const out = [];
  await sleep(2000);
  out.push(row('settled'));
  const [x0, y0, z0] = w.state.target;
  let peak = { fps: 1e9, shell: 0, mesh: 0, dirty: 0, total: 0 };
  for (let i = 1; i <= 12; i++) {
    w.go(x0 + 60 * i, y0, z0 + 25 * i);
    await sleep(260);
    const s = w.state, p = w.prof(), g = w.gridEst();
    peak.fps = Math.min(peak.fps, s.fps);
    peak.shell = Math.max(peak.shell, p.shell ?? 0);
    peak.mesh = Math.max(peak.mesh, p.mesh ?? 0);
    peak.total = Math.max(peak.total, p.total ?? 0);
    peak.dirty = Math.max(peak.dirty, g.dirty);
  }
  out.push({ peak, ...row('after drag') });
  await sleep(3000);
  out.push(row('rested 3 s'));
  return JSON.stringify(out, null, 1);
})()
