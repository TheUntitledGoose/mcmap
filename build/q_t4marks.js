const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await new Promise((r) => requestAnimationFrame(r)); w.tick(2); }
};
w.setTimePlay(0); await settle(1500);
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.31)); await settle(3500);
const H = w.HIST;
let withEdits = 0, sample = [];
for (const [k, e] of H.marks) {
  const n = e.edits?.length ?? -1;
  if (n > 0) { withEdits++; if (sample.length < 4) sample.push({ k, n, isArray: Array.isArray(e.edits), first: e.edits[0] }); }
}
const marksKeysWithEdits = sample.map((s) => s.k);
const set = new Set(marksKeysWithEdits.map((k) => k));
console.log(JSON.stringify({
  marks: H.marks.size, withEdits, sample,
  histTotals: w.histTotals(),
  // do any marker chunks appear in the marks-with-edits set at all?
  markerChunks: (() => { const s = new Set(); for (let i = 0; i < w.TLAYER.drawn; i++) s.add(`${w.TLAYER.mCx[i]},${w.TLAYER.mCz[i]}`); return s.size; })(),
  overlap: (() => { const s = new Set(); for (let i = 0; i < w.TLAYER.drawn; i++) { const k = `${w.TLAYER.mCx[i]},${w.TLAYER.mCz[i]}`; if (set.has(k)) s.add(k); } return [...s]; })(),
}, null, 1));
