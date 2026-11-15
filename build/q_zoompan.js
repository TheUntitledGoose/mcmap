// Scratch probe: drive a zoom sequence and watch the far-patch layer, the time machine, and fps through it.
const w = window.__world;
const f = (s) => [s.dist, s.detailRadius, s.payloadRadius, s.chunks, +s.fps.toFixed(0), s.queued,
  s.dirty, s.ringStuck, s.meshBuilds, s.meshUnchanged, s.patchTested, s.patchDeferred, s.patchCuts,
  s.patchCutsNew, s.patchCutsChanged, s.patchStarveMs, +s.cpuRenderMs.toFixed(1), s.verts];
const rows = [];
for (const d of [400, 900, 500, 1200, 600, 300, 800]) {
  w.orbit(0.55, 0.30, d);
  await new Promise((r) => setTimeout(r, 700));
  const early = f(w.state);
  await new Promise((r) => setTimeout(r, 2300));
  const late = f(w.state);
  rows.push('d' + d + ' early ' + early.join('/') + '  late ' + late.join('/'));
}
const s = w.state;
const h = w.hist ? w.hist() : {};
const out = { view: location.search, why: s.dirtyWhy, meshByWhy: s.meshByWhy,
  hist: { on: h.on, marked: h.marked, reshow: h.reshow, reshowTotal: h.reshowTotal,
    builds: h.builds, buildTotal: h.buildTotal, chunks: h.chunks, cap: h.cap },
  rows, errors: (window.__probeErrors || []).slice(0, 3) };
console.log('ZP ' + JSON.stringify(out));
return { ok: 1 };
