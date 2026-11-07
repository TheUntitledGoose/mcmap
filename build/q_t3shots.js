// Screenshots of the time machine drawn as blocks: arm it, let it play out, settle, then put the outline
// (or the ledger card) on the nearest drawn change. The harness shot shows the final state.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const w = window.__world;
const settle = async (ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const t0 = performance.now();
while ((!w.TLAYER.quads || w.TLAYER.drawn < w.TLAYER.quads) && performance.now() - t0 < 30000) await sleep(200);
await settle(4000);
const p = w.timeHitProbe(0);
out.probe = p.ok ? { aimed: p.probe, row: p.hit.row, voxel: p.voxel, dist: p.distance } : { why: p.why };
if (p.ok) {
  const [px, py] = p.probe;
  if (location.href.includes('card=1')) {
    await w.askAt(px, py);
    await settle(700);
    const c = document.querySelector('.lcard');
    out.card = c ? c.textContent.replace(/\s+/g, ' ').slice(0, 160) : '(none)';
  } else {
    out.hover = w.hoverAt(px, py);
  }
}
out.time = { drawn: w.TLAYER.drawn, items: w.TLAYER.quads, look: w.TLAYER.look, verts: w.state.verts };
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
