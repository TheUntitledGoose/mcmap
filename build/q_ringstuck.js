// build/q_ringstuck.js - the settle condition that never clears: which chunks sit inside the sharp
// ring with a payload in hand, no mesh, and no dirty mark? Distance tells a real hole (dist <= radius)
// from the one-chunk pad band that ringStuck() deliberately includes.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
w.go(54, 127, 63, 1200, 8);
await sleep(3000);
const [x0, y0, z0] = w.state.target;
for (let i = 1; i <= 16; i++) { w.go(x0 + 60 * i, y0, z0 + 30 * i); await sleep(250); }
let waited = 0;
while (waited < 12000) { await sleep(1000); waited += 1000; if (w.state.ringStuck[0] === 0) break; }
const s = w.state;
return {
  detailRadiusChunks: s.radius, detailR: s.detailR, ringStuck: s.ringStuck,
  held: s.chunks, queued: s.queued, dirty: s.dirty, wave: s.meshWave, jobs: s.meshJobs,
  waitedS: waited / 1000, rows: s.ringStuckRows,
  why: s.dirtyWhy, meshByWhy: s.meshByWhy, resultsDropped: s.meshResultsDropped,
};
