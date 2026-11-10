const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const fpsOf = async (ms = 2000) => { const f0 = w.state.loopFrames; const t0 = performance.now(); while (performance.now() - t0 < ms) await raf(); return +((w.state.loopFrames - f0) / ((performance.now() - t0) / 1000)).toFixed(1); };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);
w.settings.timeTouched = 1; w.settings.timeCls = 0; w.settings.timeWho = 0; w.settings.timePlay = 0;
w.timeRebuild();
for (let i = 0; i < 20; i++) { await settle(300); if (w.TLAYER.built) break; }
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
await settle(6000);
const at = (cap) => ({
  cap, look: w.TLAYER.look, want: w.settings.timeLook, why: w.TLAYER.lookWhy || '',
  markers: w.TLAYER.quads, verts: w.TLAYER.verts, drawn: w.TLAYER.drawn,
  geomBytes: w.TLAYER.mesh ? w.TLAYER.mesh.geometry.attributes.position.array.byteLength
    + (w.TLAYER.mesh.geometry.index ? w.TLAYER.mesh.geometry.index.array.byteLength : 0) : 0,
  sceneVerts: w.state.verts, buildMs: +(w.TLAYER.buildMs || 0).toFixed(0),
});
const a = at(w.settings.timeGeomMb);
const fpsA = await fpsOf();
w.settings.timeGeomMb = 512;
w.timeRebuild();
for (let i = 0; i < 30; i++) { await settle(400); if (w.TLAYER.built) break; }
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
await settle(8000);
const b = at(512);
const fpsB = await fpsOf();
w.settings.timeGeomMb = 2048;
w.timeRebuild();
for (let i = 0; i < 30; i++) { await settle(400); if (w.TLAYER.built) break; }
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
await settle(8000);
const c = at(2048);
const fpsC = await fpsOf();
console.log(JSON.stringify({
  anyChange: true, split: w.timeSplit(),
  plates_default: { ...a, fps: fpsA },
  cap512: { ...b, fps: fpsB },
  cap2048: { ...c, fps: fpsC },
  hist: w.histTotals(), err: w.TLAYER.err,
}, null, 1));
