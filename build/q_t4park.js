// Park the playhead at a fraction named in the URL (?park=0..1, default 8.35 % of the current filter,
// which is 27,644 of 331,040 changes for the any-change filter) and leave the page exactly as the URL set
// it, so --out screenshots the settings under test rather than the tail of a probe.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);
const park = Math.max(0, Math.min(1, Number(new URLSearchParams(location.search).get('park') ?? 0.0835)));
w.setTimePlay(0);
w.timeSeekRow(Math.floor(w.TLAYER.quads * park));
await settle(3500);
const s = w.timeSplit();
console.log(JSON.stringify({
  park, visible: !!(w.TLAYER.mesh && w.TLAYER.mesh.visible),
  look: w.TLAYER.look, cap: w.settings.timeGeomMb, cls: w.settings.timeCls,
  tiles: !!w.settings.timeTiles, grow: w.settings.timeGrow,
  row: w.TLAYER.cur, drawn: w.TLAYER.drawn, markers: w.TLAYER.quads, verts: w.TLAYER.verts,
  gpuMB: +((w.TLAYER.mesh.geometry.attributes.position.array.byteLength
    + (w.TLAYER.mesh.geometry.index ? w.TLAYER.mesh.geometry.index.array.byteLength : 0)) / 1048576).toFixed(1),
  hist: w.histTotals(), split: s, why: w.TLAYER.lookWhy || '',
  fps: w.state.fps, note: w.histNote(),
}, null, 1));
