// How many baked-LOD rung flips does the page make, and when? Flips are counted in the page per region
// slot whenever the rung it asks for changes, so the question is whether they happen at a still camera
// (they must not) and how many a pan costs.
const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (tag) => {
  const d = w.lodDiag();
  out.push({ tag, flips: d.flips, held: d.held, drawn: d.drawn, verts: d.verts,
    loaded: d.loaded, dropped: d.dropped, rel: d.release, ask: d.ask, rung: d.rung,
    costIdx: d.costFromIndex, gaps: d.gaps, wnt: d.wanted });
};
const [tx, ty, tz] = w.state.target;
await sleep(1000); snap('t1000');
await sleep(3000); snap('t4000');
await sleep(3000); snap('t7000');
// then a pan of ~1 100 blocks, one jump per 700 ms, like build/q_pan.js
const step = 130;
for (let i = 1; i <= 8; i++) {
  w.go(tx + step * i, ty, tz + step * i * 0.3);
  await sleep(700); snap('pan' + i);
}
await sleep(2500); snap('panEnd');
await sleep(3000); snap('rest');
const d = w.lodDiag();
out.push({ flipTail: d.flipLog.slice(-6) });
return out;
