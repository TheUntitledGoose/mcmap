// "every few seconds my screen flashes black" - measured, not guessed.
//
// Two separate things were happening and only one of them is the governor's decision rate:
//
//  1. WHEN the buffer is reallocated. setSize() throws the drawing buffer away, and the governor used
//     to run in the HUD block, which is after this frame has been drawn - so the frame that was just
//     painted got replaced by an empty buffer before it was composited. That is a black screen, once
//     per decision, whatever the decision was for.
//  2. HOW OFTEN it decides. The old controller walked a continuous multiplier as often as every 2.5 s
//     and oscillated; the ladder holds still, runs out of rungs, and locks if it is caught undoing
//     itself.
//
// So this probe watches the one call that can produce a black frame - WebGLRenderer.setSize - and
// asks, at the instant it happens, whether this frame has been drawn yet. `loopFrames -
// info.render.frame` is 1 before this frame's render and 0 after it: the difference between a frame
// the viewer never sees and a frame of black.
//
// Run with ?debug=1 (preserveDrawingBuffer, so the buffer survives a read) and no other change.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) await raf(); };
const gl = w.renderer.getContext();
const out = { url: location.href, debug: location.search.includes('debug') };

// ---- the counter that makes the ordering visible
const info = w.renderer.setSize ? w.renderer.info : null;
const realSetSize = w.renderer.setSize.bind(w.renderer);
let events = [];
w.renderer.setSize = (a, b, c) => {
  const t = performance.now();
  const beforePx = gl.drawingBufferWidth;
  const r = realSetSize(a, b, c);
  // `before` is the ordering question: 1 = this frame has not been drawn yet (safe), 0 = it already
  // has, which is the frame that composites black. `ms` is what the reallocation costs the frame.
  events.push({ before: w.state.loopFrames - info.render.frame, from: beforePx,
    to: gl.drawingBufferWidth, ms: +(performance.now() - t).toFixed(2) });
  return r;
};

out.settings = { autoOn: w.res().autoOn, res: w.res().setting, ladder: w.res().ladder,
  dpr: w.res().cap, scale: w.res().scale, samples: w.res().samples, gpuTimer: w.res().gpuTimer };

// ---- 1. the ordering invariant, on the manual path: ask, do not take
w.go(0, 100, 0); w.orbit(0.7, 0.42, 1200);
await settle(120);
const px0 = gl.drawingBufferWidth;
w.setRes(0.8);
const justAsked = { pending: w.res().pending, px: gl.drawingBufferWidth, setSizeCalls: events.length };
await raf();
const oneFrameLater = { pending: w.res().pending, px: gl.drawingBufferWidth, setSizeCalls: events.length,
  at: events.length ? events[events.length - 1].before : null };
out.order = { px0, justAsked, oneFrameLater,
  askedBeforeDraw: justAsked.pending === true && justAsked.px === px0 && !justAsked.setSizeCalls,
  takenAtFrameTop: oneFrameLater.pending === false && oneFrameLater.at === 1
    && oneFrameLater.px !== px0 };

// ---- 2. what one reallocation costs, so "and it stutters" has a number
const time = async (fn) => { const t = performance.now(); await fn(); return +(performance.now() - t).toFixed(2); };
const bare = [], full = [];
for (let i = 0; i < 4; i++) {
  bare.push(await time(async () => { await raf(); await raf(); }));
  full.push(await time(async () => { w.setRes(i % 2 ? 1 : 0.9); await raf(); await raf(); }));
}
w.setRes(1); await raf();
out.reallocCostMs = { twoFramesNoRealloc: bare, twoFramesWithRealloc: full,
  medianDelta: (() => { const d = full.map((v, i) => v - bare[i]).sort((a, b) => a - b);
    return d.length ? +d[d.length >> 1].toFixed(2) : null; })() };

// ---- 3. decide a lot: make the card genuinely slow and let the governor walk
// A 2x multiplier is 4x the pixels; the governor should run down the ladder, stop at the floor, and
// stay there. Count the reallocations that produce, and the time between them.
const c0 = w.res().changes;
const tl = [];
w.setRes(2);
const t0 = performance.now();
for (let k = 0; k < 40; k++) {
  await settle(15);
  const r = w.res();
  tl.push([Math.round(performance.now() - t0), r.changes - c0, r.rung, +r.auto.toFixed(2), +r.gpuMs.toFixed(1), r.locked]);
}
const ms = events.map((e) => e.ms).sort((a, b) => a - b);
out.reallocMs = { n: ms.length, median: ms.length ? ms[ms.length >> 1] : null, max: ms[ms.length - 1] ?? null,
  events: events.slice(0, 8) };
out.walkDown = { changes: w.res().changes - c0, finalRung: w.res().rung, auto: w.res().auto,
  locked: w.res().locked, everyFrameBeforeDraw: events.every((e) => e.before === 1),
  gpuMs: +w.res().gpuMs.toFixed(1), tl: tl.filter((x) => x[1] >= 0).filter((_, i) => i % 3 === 0) };

// ---- 4. a real pan at a real framing: how many black frames does the user actually get now?
w.setRes(1);
const c1 = w.res().changes;
const fps = [];
for (let k = 0; k < 16; k++) {
  w.go(-3000 + k * 400, 100, 1200);
  await settle(30);
  fps.push(Math.round(w.state.fps));
}
out.pan = { seconds: 8, changes: w.res().changes - c1, rung: w.res().rung, auto: w.res().auto,
  locked: w.res().locked, fps, frames: w.state.loopFrames };

// ---- 5. nothing is left pending across a frame boundary, ever
await settle(3);
out.quiet = { pending: w.res().pending, setSizeCalls: events.length,
  allAtFrameTop: events.length ? events.every((e) => e.before === 1) : 'no reallocs in this run' };
w.renderer.setSize = realSetSize;
return out;
