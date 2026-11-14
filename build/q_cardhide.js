// The picture for a chat link: no panel, no fps pill, no instrument rows, no name tags. The pill saying
// "1 fps" is a true fact about a headless SwiftShader frame and a false fact about the server, and a card
// is the one frame a stranger will look at.
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const gone = [];
for (const sel of ['.panel', '#pill', '#hud', '#help', '#pbar', '.gtag', '#card']) {
  for (const el of document.querySelectorAll(sel)) { el.style.display = 'none'; gone.push(sel); }
}
document.body.classList.remove('loading');
await settle(1500);
const s = __world.state;
return {
  verts: s.verts, fps: s.fps, dirty: s.dirty, hidden: [...new Set(gone)],
  lod: (() => { try { const d = __world.lodDiag(); return { held: d.held, hiddenTiles: d.hidden }; } catch { return null; } })(),
};
