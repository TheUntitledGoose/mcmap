const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await new Promise((r) => requestAnimationFrame(r)); w.tick(2); }
};
w.setTimePlay(0);
await settle(1500);
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.31));
await settle(3500);
const H = w.HIST;
const keys = [...H.marks.keys()];
const first = H.marks.get(keys[0]);
console.log(JSON.stringify({
  marks: keys.length, keys: keys.slice(0, 5), entryKeys: first && Object.keys(first),
  editsOfFirst: first && (first.edits ? first.edits.length : null),
  hist: w.histTotals(), stats: w.histStats(),
  split: w.timeSplit(), splitAgain: (w.timeRebuild && w.histNote(), w.timeSplit()),
  mCx: Array.from(w.TLAYER.mCx.slice(0, 6)), mCz: Array.from(w.TLAYER.mCz.slice(0, 6)),
  drawn: w.TLAYER.drawn, detailRadius: w.state.detailRadius,
}, null, 1));
