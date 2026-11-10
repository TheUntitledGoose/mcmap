const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);
const snap = (tag) => {
  const s = w.histStats(), t = w.histTotals(), sp = w.timeSplit(), H = w.HIST;
  return { tag, on: s.on, wanted: s.wanted, cur: s.cur, gen: s.gen, marks: H.marks.size,
    withEdits: [...H.marks.values()].filter((e) => e.edits.length).length,
    marked: s.marked, restore: s.restore, capped: s.capped, builds: s.builds, buildTotal: s.buildTotal,
    syncMs: +s.syncMs.toFixed(1), totals: t, cut: sp.chunksCut, inRing: sp.inRing,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    look: w.TLAYER.look, cap: w.settings.timeGeomMb, drawn: w.TLAYER.drawn };
};
const out = [];
w.settings.timeTouched = 1; w.settings.timeCls = 0; w.settings.timeWho = 0; w.settings.timePlay = 0;
w.timeRebuild();
for (let i = 0; i < 20; i++) { await settle(300); if (w.TLAYER.built) break; }
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
await settle(8000);
out.push(snap('cap128_plates'));
for (const cap of [512, 2048]) {
  w.settings.timeGeomMb = cap;
  w.timeRebuild();
  out.push(snap(`just_rebuilt_cap${cap}_before_settle`));
  for (let i = 0; i < 30; i++) { await settle(400); if (w.TLAYER.built) break; }
  w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
  await settle(10000);
  out.push(snap(`cap${cap}`));
}
console.log(JSON.stringify(out, null, 1));
