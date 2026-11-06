// price each end of the new close-detail scale at one fixed framing (300 m orbit)
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (ask) => {
  const s = w.state;
  return {
    ask, ring: s.detailRadius, chunks: s.chunks, verts: s.verts, detVerts: s.detailVerts,
    demoted: s.demoted, fps: +s.fps.toFixed(1), stuck: s.ringStuck, meshMs: s.meshMs,
    parkMB: +(s.bytesHeld / 1e6).toFixed(0),
  };
};
const out = [];
await sleep(5000);
out.push(sample('default'));
for (const r of [12, 16, 24, 32]) {
  w.set('radius', r);
  for (let i = 0; i < 5; i++) { await sleep(2000); w.tick(2); }
  out.push(sample(String(r)));
}
return JSON.stringify(out, null, 1);
