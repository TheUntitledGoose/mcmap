// Why is a baked tile skipped (or not)? Ask the page for the patch grid under the tile it is standing on.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const params = new URLSearchParams(location.search);
for (let i = 0; i < 80 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
await settle(6000);
const out = { framing: location.search, S: w.S };
out.why = w.lodHideWhy();
out.diag = w.lodDiag();
out.state = { verts: w.state.verts, patches: w.state.patches, chunks: w.state.chunks, skinR: w.state.skinR, farR: w.state.farR };
// and for the tiles a few regions away, to see where live ground stops
const D = w.lodDiag();
out.whyFar = [];
const t = w.state.target || w.state.eye;
const rx0 = Math.floor(t[0] / 512), rz0 = Math.floor(t[2] / 512);
for (const d of [[0, 0], [1, 0], [2, 0], [0, 2], [3, 3]]) {
  const cell = out.why.cell || 16;
  const k = `${out.why.cell || 16},${rx0 + d[0]},${rz0 + d[1]}`;
  try { const q = w.lodHideWhy(k); out.whyFar.push({ k, hidden: q.hidden, miss: q.miss.length, painted: q.painted }); } catch (e) { out.whyFar.push({ k, err: String(e) }); }
}
console.log('HIDE ' + JSON.stringify(out));
