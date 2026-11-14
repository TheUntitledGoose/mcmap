// Where do the frames go? The page already keeps cost buckets (`lap`), an auto-resolution governor
// (`res`), and three's own counters (`renderer.info`). This walks one framing through a few switches and
// prints fps per state, so a cost is attributed to a LAYER rather than guessed from a screenshot.
//
// Read it with: settled fps per state, the CPU bucket table, three's call/triangle counts, and the draw
// resolution the governor chose. A change that moves fps without moving a counter is a fill-rate story;
// one that moves a counter is a work story.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

async function fps(ms = 4000) {
  // Measure over frames, not wall clock: the loop can be starved by a re-cut, and "fps" over a window that
  // contains a 2 s hitch is not the number a viewer feels while the world is standing still.
  const f0 = w.state.loopFrames, t0 = performance.now();
  const frames = [];
  let last = f0, lastT = t0;
  while (performance.now() - t0 < ms) {
    await raf();
    if (w.state.loopFrames > last) { const t = performance.now(); frames.push(t - lastT); last = w.state.loopFrames; lastT = t; }
  }
  const span = (w.state.loopFrames - f0) / ((performance.now() - t0) / 1000);
  const sorted = frames.slice(1).sort((a, b) => a - b);
  return { fps: +span.toFixed(1), frames: w.state.loopFrames - f0,
    medFrameMs: sorted.length ? +sorted[sorted.length >> 1].toFixed(1) : null,
    p95FrameMs: sorted.length ? +sorted[Math.floor(sorted.length * 0.95)].toFixed(1) : null,
    worstFrameMs: sorted.length ? +sorted[sorted.length - 1].toFixed(1) : null };
}

const params = new URLSearchParams(location.search);
const seek = params.get('seek');
for (let i = 0; i < 80 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
if (seek !== null) { w.setTimePlay(0); w.seekSec(+seek); w.setTimePlay(0); }
await settle(2500);

const info = () => {
  const i = w.rendInfo ? w.rendInfo() : null;
  return i;
};
const snap = () => {
  const t = w.time(), s = w.state, L = w.lodDiag ? w.lodDiag() : null;
  return { fps: null, verts: s.verts, tris: s.tris, drawn: t.drawn, quads: t.quads, look: t.look,
    markerGeoMb: t.markerGeoMb, res: w.res().scale, autoOn: w.res().autoOn, gpuMs: w.res().gpuMs,
    cpuRenderMs: w.res().cpuRenderMs, calls: info() && info().calls, trisGpu: info() && info().triangles,
    progs: info() && info().programs, people: w.ghosts().standing, seen: w.ghosts().seenDrawn,
    // the baked layer: held / submitted / skipped-because-the-clip-killsthem-all, and how many
    // patches the live ground actually paints (the fact the skip is built on)
    lodHeld: L && L.held, lodTiles: L && L.drawn, lodVerts: L && L.verts,
    lodHideOn: L && L.hideOn, lodSkip: L && L.hiddenTiles, lodSkipVerts: L && L.hiddenVerts,
    painted: L && L.paintedPatches, anchor: L && L.anchor, clipOn: L && L.clipOn, cov: L && L.cov,
    shellPatches: s.patches, detailChunks: s.chunks, skinR: s.skinR, farR: s.farR};
};

const out = { framing: location.search, states: {} };
const run = async (name, on) => {
  if (on) on();
  await settle(2500);
  const f = await fps(Number(params.get('ms') || 4000));
  out.states[name] = Object.assign(snap(), f);
  console.log('FPS ' + name + ' ' + JSON.stringify(out.states[name]));
};

await run('asLoaded');
if (params.get('abtime') !== null) { await run('timeOff', () => w.set('time', 0)); await run('timeBackOn', () => w.set('time', 1)); }
if (params.get('abbodies') !== null) { await run('bodiesOff', () => w.set('bodies', 0)); await run('bodiesOn', () => w.set('bodies', 1)); }
if (params.get('abdepth') !== null) { w.markDepth(0); out.markDepth = w.markDepth(0); await run('markDepthOff'); w.markDepth(1); }
if (params.get('ablod') !== null) { await run('lodOff', () => w.set('lodtiles', 0)); await run('lodOn', () => w.set('lodtiles', 1)); }
// The skip itself, A/B: same tiles held, same clip, only the draw call differs.
if (params.get('ablodhide') !== null) {
  await run('hideOff', () => { w.lodHide(0); });
  await run('hideOn', () => { w.lodHide(1); });
  out.hideDiag = w.lodDiag();
  out.hideVerts = w.state.verts;
}
if (params.get('abres') !== null) { await run('resHalf', () => w.set('res', 0.5)); await run('resBack', () => w.set('res', 1)); }
out.prof = w.prof();
out.res = w.res();
out.info = info();
out.errs = { frameErrors: w.state.frameErrors, frameError: w.state.frameError };
console.log('FPSPROF ' + JSON.stringify(out));
