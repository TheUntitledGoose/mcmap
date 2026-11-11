// A screenshot without the panel in it, plus the marker layer's own numbers. The panel covers a third of
// every frame, which is how a "fixed" screenshot once got approved while the picture was still wrong.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
await settle(1500);
const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';
await settle(1200);
const t = w.time();
return {
  verts: w.state.verts, drawn: w.state.drawn, dirty: w.state.dirty, fps: w.state.fps,
  markers: t.quads, markerVerts: t.verts, markerDrawn: t.drawn, look: t.look,
  grow: t.grow, stackRamp: t.stackRamp, faceCull: t.faceCull,
  culledFaces: t.culledFaces, fullyInside: t.fullyInside, dedupedClaims: t.dedupedClaims,
  maxStack: t.maxStack, polyOffset: t.polyOffset, depthTest: t.depthTest,
  note: w.timeNote(), panelHasFollow: (w.panelKeys?.() ?? []).includes('follow'),
  err: t.err || '',
};
