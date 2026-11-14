// Does skipping a fully-clipped baked tile change a single pixel? Same page, same tiles, one switch.
// Two questions, because "no difference" is only meaningful next to "the ground is still there":
//   1. skip on vs skip off -> how many pixels differ (must be 0)
//   2. how many pixels are non-sky in each frame (must match: the distance was not erased)
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const params = new URLSearchParams(location.search);
const TOL = Number(params.get('tol') || 3);
// A whole-world view is still re-cutting for a while: a patch retired between two grabs moves pixels
// whether or not the switch moved, so an A/B there is only honest once the live layer is idle.
const idle = async (ms = 60000) => {
  const t0 = performance.now();
  for (;;) {
    const st = w.state, b = w.progress();
    const farWork = (b.patch && (b.patch.dirty || b.patch.queued)) || 0;
    if (!st.dirty && !st.queued && !st.inflight && !farWork) break;
    if (performance.now() - t0 > ms) break;
    await settle(500);
  }
  const st = w.state, b = w.progress();
  return { waitedMs: Math.round(performance.now() - t0), dirty: st.dirty, queued: st.queued,
    inflight: st.inflight, dirtyPatches: st.dirtyPatches, patchQueued: b.patch && b.patch.queued,
    patchDirty: b.patch && b.patch.dirty, meshUnsettled: st.meshUnsettled };
};
for (let i = 0; i < 80 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
await settle(Number(params.get('settle') || 8000));
const idle0 = params.get('idle') !== null ? await idle(Number(params.get('idlems') || 60000)) : null;

const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
const px = (G, x, y) => {
  const gx = Math.floor((x + 0.5) * G.dpr), gy = Math.floor((G.h - y - 0.5) * G.dpr);
  const i = (gy * G.w + gx) * 4;
  return [G.buf[i], G.buf[i + 1], G.buf[i + 2]];
};
const render = async () => { await raf(); await raf(); await new Promise((r) => setTimeout(r, 900)); };
const diff = (A, B) => {
  let n = 0, worst = 0, sampled = 0; const where = [];
  const step = Number(params.get('step') || 4);
  const H = Math.min(A.h, B.h), W = Math.min(A.w, B.w);
  for (let sy = 0; sy < H; sy += step) {
    for (let sx = 0; sx < W; sx += step) {
      const gx = Math.floor((sx + 0.5) * A.dpr), gy = Math.floor((A.h - sy - 0.5) * A.dpr);
      const i = (gy * A.w + gx) * 4, j = (gy * B.w + gx) * 4;
      const d = Math.max(Math.abs(A.buf[i] - B.buf[j]), Math.abs(A.buf[i + 1] - B.buf[j + 1]), Math.abs(A.buf[i + 2] - B.buf[j + 2]));
      sampled++;
      if (d > worst) worst = d;
      if (d > TOL) { n++; if (where.length < 6) where.push({ sx, sy, d,
        a: [A.buf[i], A.buf[i + 1], A.buf[i + 2]], b: [B.buf[j], B.buf[j + 1], B.buf[j + 2]] }); }
    }
  }
  return { changed: n, sampled, worst, where };
};
// "is there anything painted out there?" The sky colour is not hard-coded: the top corner of the frame
// is sky by construction, so everything that differs from IT is ground. A skip that erased the distance
// would show up here as a collapse, even if the A/B itself said "no difference".
const painted = (G) => {
  const i0 = ((G.h - 5) * G.w + 5) * 4;
  const sky = [G.buf[i0], G.buf[i0 + 1], G.buf[i0 + 2]];
  let n = 0;
  for (let gy = 0; gy < G.h; gy += 8) {
    for (let gx = 0; gx < G.w; gx += 8) {
      const i = (gy * G.w + gx) * 4;
      if (Math.max(Math.abs(G.buf[i] - sky[0]), Math.abs(G.buf[i + 1] - sky[1]), Math.abs(G.buf[i + 2] - sky[2])) > 12) n++;
    }
  }
  return { sky, n, of: Math.ceil(G.h / 8) * Math.ceil(G.w / 8) };
};

const out = { framing: location.search, idle0, legs: {} };
const step = async (name, on) => {
  const r = w.lodHide(on);
  await settle(1200);
  if (params.get('idle') !== null) await idle(Number(params.get('idlems') || 60000));
  const g = (await render(), grab());
  const D = w.lodDiag();
  out.legs[name] = {
    switch: r, hideOn: D.hideOn, held: D.held, drawnTiles: D.drawn, hiddenTiles: D.hiddenTiles,
    hiddenVerts: D.hiddenVerts, lodVerts: D.verts, paintedPatches: D.paintedPatches,
    cov: D.cov, ground: painted(g), info: w.rendInfo(),
  };
  console.log('HPXLEG ' + name + ' ' + JSON.stringify(out.legs[name]));
  return g;
};

const on1 = await step('hideOnA', 1);
const off = await step('hideOff', 0);
const on2 = await step('hideOnB', 1);
out.skipVsNoSkip = diff(off, on1);
// what lives at a pixel that the skip moved: the page's own answer, both ways
out.whereAsk = (out.skipVsNoSkip.where ?? []).map((q) => {
  const r1 = w.lodHide(0); const a = w.pickStack ? w.pickStack(q.sx, q.sy) : w.ownerAt(q.sx, q.sy);
  w.lodHide(1); const b = w.pickStack ? w.pickStack(q.sx, q.sy) : w.ownerAt(q.sx, q.sy);
  const t = w.lodAt ? w.lodAt(...(w.camTarget ? w.camTarget() : [0, 0])) : null;
  return { at: [q.sx, q.sy], skipOff: a, skipOn: b };
});
out.controlPair = diff(on1, on2);
out.verts = { withSkip: w.state.verts };
out.state = { verts: w.state.verts, chunks: w.state.chunks, patches: w.state.patches };
out.errs = { frameErrors: w.state.frameErrors, frameError: w.state.frameError };
console.log('HPX ' + JSON.stringify(out));
