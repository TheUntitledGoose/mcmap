// A pan at whole-world framing, on the real GPU, sampled in time: fps next to the four things that
// can each be the reason - measured GPU ms, main-thread submission, main-thread JS buckets, and how
// much meshing work is in flight. The interesting failure is "fps 57 while JS is 4 ms".
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (note) => {
  const s = w.state, p = w.prof(), g = w.gridEst(), r = w.res();
  return { note, fps: +s.fps.toFixed(0), gpu: +(r.gpuMs ?? 0).toFixed(2),
    submit: +(s.cpuRenderMs ?? 0).toFixed(2), verts: (s.verts / 1e6).toFixed(1),
    drawn: s.drawn, js: +p.total.toFixed(2), shell: +(p.shell ?? 0).toFixed(2),
    mesh: +(p.mesh ?? 0).toFixed(2), count: +(p.count ?? 0).toFixed(2),
    far: [g.dirty, g.cuts, +(g.cutMs ?? 0).toFixed(2)],
    pool: [s.workers, s.workerReady, s.meshJobs, s.meshWave, s.dirty],
    lod: [s.lodTiles, s.lodVerts / 1e6].map((x) => +(+x).toFixed(1)),
    park: +(s.bytesHeld / 1e6).toFixed(0) };
};
const out = [];
await sleep(4000);
out.push(row('settled'));
const [x0, y0, z0] = w.state.target;
for (let i = 1; i <= 10; i++) {
  w.go(x0 + 70 * i, y0, z0 + 30 * i);
  await sleep(400);
  if (i % 3 === 0) out.push(row('drag x' + i));
}
for (const t of [500, 1500, 3000, 6000]) { await sleep(t === 500 ? 500 : 1000); out.push(row('rest +' + t)); }
w.set('dist', 1200);
return JSON.stringify(out, null, 1);
