// Where a pan's stutter actually is: per-frame main-thread work, bucketed.
//
// The settled frame is not what a pan feels like, and an fps number from a headless run is not the
// user's monitor either. So record every frame during a scripted pan and ask two questions:
//   1. how bad is the distribution (how many frames blow past 33/50/100 ms of *work*), and
//   2. which bucket owns those frames.
// `__world.profAll()` returns cumulative bucket means and the frame count, so totals are (mean x
// frames) and a difference across two samples is that frame's cost - no page changes needed.
//
// The pan is 16 legs of (60, 30) blocks 250 ms apart: a drag, not a teleport. Anything that reads
// well under this is worth believing; the settled frame flatters every fix.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = ['view', 'mesh', 'refill', 'shell', 'ov', 'demote', 'count', 'render'];
const totals = () => {
  // Raw sums when the page offers them. An older page only has rounded *means*, and differencing
  // those is off by 0.005 ms x frames - fine for a baseline comparison, not for one frame's cost.
  const p = w.profTotals ? w.profTotals() : (() => {
    const m = w.profAll();
    const o = { frames: m.frames };
    for (const k of KEYS) o[k] = m[k] * m.frames;
    return o;
  })();
  const n = p.frames || 1;
  const t = { frames: n };
  for (const k of KEYS) t[k] = p[k];
  return t;
};

const cheap = () => {
  const s = w.state;
  return { jobs: s.meshJobs, wave: s.meshWave, dirty: s.dirty, inflight: s.inflight, chunks: s.chunks,
    lod: s.lodTiles, patches: s.shellPatches, drawn: s.drawn, verts: s.verts, retired: s.retired,
    patchTested: s.patchTested, patchDeferred: s.patchDeferred, patchCuts: s.patchCuts,
    patchQueue: s.patchQueue, workerCuts: s.patchWorkerJobs,
    patchCutsNew: s.patchCutsNew, patchCutsChanged: s.patchCutsChanged,
    cutMs: s.patchCutMsAvg, jobMs: s.patchJobMsAvg, sigMs: s.patchSigMsAvg,
    // cumulative worst cut so far: cheap() before the pan and after it tells you the pan's worst cut
    cutMax: s.patchCutMax, cutMaxCell: s.patchCutMaxCell, cutMaxPk: s.patchCutMaxPk,
    cutByCell: JSON.stringify(s.patchCutMsByCell ?? {}),
    deferredBig: s.patchDeferredBig, forced: s.patchForced,
    cappedIdle: s.patchCappedIdle, stolen: s.patchStolen,
    meshBuilds: s.meshBuilds, chunks: s.chunks, meshTotalMs: s.mesh, meshAvgMs: s.meshMs };
};

const frames = [];                       // {dt, work, b{}, pan: bool}
let run = false, prevT = 0, prevP = 0, panT0 = 0;
const sample = () => {
  const t = performance.now();
  const p = totals();
  if (run && prevP) {
    const dn = Math.max(1, p.frames - prevP.frames);
    const b = {};
    let sum = 0;
    for (const k of KEYS) { b[k] = (p[k] - prevP[k]) / dn; sum += b[k]; }
    frames.push({ dt: t - prevT, work: sum, b, dn, ms: t - panT0 });
  }
  prevT = t; prevP = p;
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);

await sleep(4000);
const a = cheap();
run = true;
const panStart = performance.now();
panT0 = panStart;
const [x0, y0, z0] = w.state.target;
for (let i = 1; i <= 16; i++) { w.go(x0 + 60 * i, y0, z0 + 30 * i); await sleep(250); }
let waited = 0;
const patchSeries = [];
let why = '';
const stuck = (s) => {
  const bad = [];
  if ((s.meshWave ?? 0) !== 0) bad.push(`wave ${s.meshWave}`);
  if ((s.meshJobs ?? 0) !== 0) bad.push(`jobs ${s.meshJobs}`);
  if ((s.dirty ?? 0) !== 0) bad.push(`storeDirty ${s.dirty}`);
  if (s.ringStuck[0] !== 0) bad.push(`ringStuck ${JSON.stringify(s.ringStuck)}`);
  if ((s.patchQueue ?? 0) > 2) bad.push(`patchQueue ${s.patchQueue}`);
  return bad.join(', ');
};
while (waited < 20000) {
  await sleep(1000); waited += 1000;
  const s = w.state;
  patchSeries.push([waited / 1000, s.patchQueue ?? 0, (s.patchCuts ?? 0) - (a.patchCuts ?? 0),
    (s.patchTested ?? 0) - (a.patchTested ?? 0), (s.patchDeferred ?? 0) - (a.patchDeferred ?? 0)]);
  why = stuck(s);
  if (!why) break;
}
run = false;
const b = cheap();                       // settled: work must have FINISHED, not moved elsewhere

const dts = frames.map((f) => f.dt).sort((x, y) => x - y);
// The pan window on its own. `dt` needs no derivation, so it is the one number both the old and the
// new page can be compared on: a headless rAF is not vsync-locked, so what matters is the shape of
// the tail, not whether p50 reads 4 ms or 16.
const inPan = frames.filter((f) => f.ms <= 4200);
const pdts = inPan.map((f) => f.dt).sort((x, y) => x - y);
// Busy frames only: rAF keeps firing while the page idles, and a p90 over 5 000 idle frames says
// nothing about the frames that were actually working. `busy` = a frame that spent > 1 ms in the
// measured passes.
const busy = frames.filter((f) => f.work > 1);
const bdts = busy.map((f) => f.dt).sort((x, y) => x - y);
const bw = busy.map((f) => f.work).sort((x, y) => x - y);
const pct = (q, arr) => +(arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0).toFixed(1);
const work = frames.map((f) => f.work).sort((x, y) => x - y);
const agg = {};
for (const k of KEYS) agg[k] = +frames.reduce((s2, f) => s2 + f.b[k], 0).toFixed(1);
const shareOf = Object.values(agg).reduce((s2, v) => s2 + v, 0) || 1;
const worst = frames.slice().sort((x, y) => y.work - x.work).slice(0, 6)
  .map((f) => ({ work: +f.work.toFixed(1), dt: +f.dt.toFixed(1),
    top: Object.entries(f.b).sort((p, q) => q[1] - p[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') }));
const r = w.res();
return {
  parsed: { radius: w.state.radius, detailPixels: w.state.detailPixels, lodOn: w.state.lodOn,
    detailReach: w.state.detailReachBlocks, drawRes: w.res().setting, autoRes: w.res().autoOn,
    workers: w.state.workers, workerReady: w.state.workerReady, aa: w.state.aa,
    shellBudgetMs: w.state.shellBudgetMs, demoteBudgetMs: w.state.demoteBudgetMs,
    patchQuiesce: w.state.patchQuiesce, cellPrice: w.state.patchCellPrice,
    starveMs: w.state.patchStarveMs, stealMs: w.state.patchStealMs },
  framesSampled: frames.length, panWallS: +((performance.now() - panStart) / 1000).toFixed(1),
  settleAfterPanS: waited / 1000, settleNot: why,
  // [second, dirty far patches, cuts since pan start, signature tests, patches left marked]. A queue
  // that never drains while cuts keep climbing is a re-cut loop, not settling.
  patchSeries,
  frameDtMs: { p50: pct(0.5, dts), p90: pct(0.9, dts), p99: pct(0.99, dts), max: pct(1, dts) },
  // Frames while the drag is running: this is what a pan feels like.
  panDtMs: { n: pdts.length, p50: pct(0.5, pdts), p90: pct(0.9, pdts), p99: pct(0.99, pdts),
    max: pct(1, pdts), over33: pdts.filter((v) => v > 33).length,
    over50: pdts.filter((v) => v > 50).length, over100: pdts.filter((v) => v > 100).length },
  over33ms: dts.filter((v) => v > 33).length, over50: dts.filter((v) => v > 50).length,
  over100: dts.filter((v) => v > 100).length,
  workMsPerFrame: { p50: pct(0.5, work), p90: pct(0.9, work), p99: pct(0.99, work), max: pct(1, work) },
  // The stutter the user reports: on frames that were doing work, how long the frame took.
  busyFrames: busy.length,
  busyDtMs: { p50: pct(0.5, bdts), p90: pct(0.9, bdts), p99: pct(0.99, bdts), max: pct(1, bdts),
    over33: bdts.filter((v) => v > 33).length, over50: bdts.filter((v) => v > 50).length },
  busyWorkMs: { p50: pct(0.5, bw), p90: pct(0.9, bw), p99: pct(0.99, bw), max: pct(1, bw) },
  overWork33: work.filter((v) => v > 33).length, overWork50: work.filter((v) => v > 50).length,
  bucketTotalsMs: agg,
  bucketShare: Object.fromEntries(Object.entries(agg).map(([k, v]) =>
    [k, +(v / shareOf * 100).toFixed(1)])),
  worstFrames: worst,
  gpu: { ms: +r.gpuMs.toFixed(2), timer: r.gpuTimer, dead: r.timerDead, resScale: +r.scale.toFixed(3),
    resChanges: r.changes },
  counters: { before: a, settled: b },
  // What the far pass paid per cell, and what it refused to run inline (shared/cutpolicy.mjs). The
  // 47 ms frames have to be answerable, so the last cuts are named: cell, ms, path, first-mesh.
  cutBill: { starveMs: w.state.patchStarveMs, byCell: w.state.patchCutMsByCell,
    deferredBig: w.state.patchDeferredBig, forced: w.state.patchForced,
    cappedIdle: w.state.patchCappedIdle, stolen: w.state.patchStolen, stealMs: w.state.patchStealMs,
    cuts: w.state.patchCuts, cutMsAvg: w.state.patchCutMsAvg, workerJobs: w.state.patchWorkerJobs,
    biggest: (w.state.patchCutLog ?? []).slice().sort((x, y) => y.ms - x.ms).slice(0, 4) },
};
