// Does the sharp ring refill when the view CENTRE moves but its radius does not?
// ringStuck = [held chunks inside the sharp ring with no mesh, how many of those are in the mesh
// queue]. [n, 0] with n > 0 is the failure: work nobody will ever ask for again.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (t) => { const s = w.state; return { t, ring: s.detailRadius, payload: s.payloadRadius,
    held: s.chunks, meshed: s.meshed, stuck: s.ringStuck, dirty: s.dirty, verts: s.verts }; };
  await sleep(8000); w.tick(2);
  const out = [row('settled')];
  // A pan: the target slides, the ring radius does not.
  const [x0, y0, z0] = w.state.target;
  for (let i = 1; i <= 4; i++) { w.go(x0 + 20 * i, y0, z0 + 20 * i); await sleep(300); }
  for (const ms of [500, 1500, 3000, 6000]) { await sleep(ms); w.tick(2); out.push(row('scan t+' + ms)); }
  // Same kind of pan with the centre scan switched off, into ground never visited before: panning
  // back over ground that already has meshes proves nothing.
  w.settings.ringScan = 0;
  const [x1, y1, z1] = w.state.target;
  for (let i = 1; i <= 4; i++) { w.go(x1 + 20 * i, y1, z1 - 20 * i); await sleep(300); }
  for (const ms of [500, 1500, 3000, 6000]) { await sleep(ms); w.tick(2); out.push(row('noscan t+' + ms)); }
  const s = w.state;
  return JSON.stringify({ workers: `${s.workerReady}/${s.workers}`, rows: out }, null, 1);
})()
