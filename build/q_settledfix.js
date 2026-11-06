// The settled frame's cost, bucketed per frame. A pan is where the stutter lives, but a pan also has
// a hundred moving parts; the settled frame isolates what the page pays every frame just to draw the
// world as it already stands - the part that can be removed by drawing it more cheaply.
// `?matrixlive=1` puts three.js's per-frame matrix recomputation back for an A/B.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = ['view', 'mesh', 'refill', 'shell', 'ov', 'demote', 'count', 'render'];
await sleep(7000);                       // settle: nothing should be building any more
const s0 = w.state;
const atRest = (s0.meshJobs === 0 && s0.meshWave === 0 && s0.dirty === 0) ? 1 : 0;
const before = w.profTotals();
const t0 = performance.now();
await sleep(3000);
const after = w.profTotals();
const wall = performance.now() - t0;
const nf = Math.max(1, after.frames - before.frames);
const per = {};
for (const k of KEYS) per[k] = +((after[k] - before[k]) / nf).toFixed(3);
return {
  parsed: { staticMatrix: w.state.staticMatrix, aa: w.state.aa, drawRes: w.res().setting },
  atRestBeforeMeasure: atRest, frames: nf, fps: +(1000 * nf / wall).toFixed(1),
  perFrameMs: per,
  sumMs: +Object.values(per).reduce((a, b) => a + b, 0).toFixed(2),
  drawn: w.state.drawn, verts: w.state.verts, patches: w.state.shellPatches,
  gpuMs: +w.res().gpuMs.toFixed(2),
};
