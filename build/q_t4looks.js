const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const fpsOf = async (ms = 2000) => { const f0 = w.state.loopFrames; const t0 = performance.now(); while (performance.now() - t0 < ms) await raf(); return +((w.state.loopFrames - f0) / ((performance.now() - t0) / 1000)).toFixed(1); };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);
const Mib = (b) => +(b / 1048576).toFixed(1);
const gpu = () => (w.TLAYER.mesh ? Mib(w.TLAYER.mesh.geometry.attributes.position.array.byteLength
  + (w.TLAYER.mesh.geometry.index ? w.TLAYER.mesh.geometry.index.array.byteLength : 0)) : 0);
const snap = (tag) => ({ tag, want: w.settings.timeLook, look: w.TLAYER.look, cap: w.settings.timeGeomMb,
  cls: w.settings.timeCls, markers: w.TLAYER.quads, verts: w.TLAYER.verts, drawn: w.TLAYER.drawn,
  lookMb: w.TLAYER.lookBytes, gpuMB: gpu(), buildMs: +(w.TLAYER.buildMs || 0).toFixed(0),
  why: w.TLAYER.lookWhy || '', hist: w.histTotals(), cut: w.timeSplit().chunksCut,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null });

const out = [];
// the default path first: nothing but the time-machine box, at the framing in the user's screenshots
out.push({ ...snap('boot_default'), fps: await fpsOf() });
// then the two big filters at a ceiling so small that BOTH looks are refused: this is where the
// step-down sentence has to name both numbers
for (const cls of [1, 0]) {
  w.settings.timeCls = cls;
  w.settings.timeGeomMb = 4;
  w.timeRebuild();
  for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
  out.push({ ...snap(`cls${cls}_cap4`), fps: await fpsOf() });
}
// and the ceiling that lets the whole any-change filter stand as blocks
w.settings.timeCls = 0;
w.settings.timeGeomMb = 384;
w.timeRebuild();
for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
out.push({ ...snap('cls0_cap384'), fps: await fpsOf() });
// a look change must NOT throw away the marks of work the page has already undone
w.settings.timeLook = 'plates';
w.timeRebuild();
for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
out.push({ ...snap('after_look_change_plates'), histOn: w.histStats().on });
w.settings.timeLook = 'blocks';
w.timeRebuild();
for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
out.push({ ...snap('back_to_blocks'), fps: await fpsOf() });
console.log(JSON.stringify({ frames: out, split: w.timeSplit(), err: w.TLAYER.err }, null, 1));
