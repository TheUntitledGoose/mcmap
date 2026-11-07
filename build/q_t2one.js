// One chunk, one question: does the page's own undo build edits there?
// The whole-frame A/B reported "192 chunks marked, 0 blocks undone", which is either the mark scan
// spending its cap on distant chunks or editsForCell answering empty. This asks one named chunk.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 300) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
await sleep(0);
const out = {};
// filter comes from the URL; assigning settings.timeCls alone would not rebuild the layer
w.settings.timeTiles = 0;
w.go(-236, 78, 137);
w.orbit(0.6, 0.55, 14);
w.timeSeekRow(0);
await settle();
out.wanted = w.histWanted();
out.playhead = w.time();
out.stampOf = w.histStampOf(-15, 8);
out.held = w.state.detailChunks ?? null;
w.settings.timeTerrain = 1; w.histSync(true);
await settle(120);
const m = w.histEditsOf(-15, 8);
out.mark = m ? { edits: m.edits, break: m.breakRows, place: m.placeRows, change: m.changeRows,
  other: m.otherRows, unknown: m.unknown, truncated: m.truncated, stamp: m.stamp } : null;
out.marked = w.HIST ? [...w.HIST.marks.keys()].slice(0, 12) : null;
out.stats = w.histStats();
out.totals = w.histTotals();
out.pick = (() => { const p = w.pickState(innerWidth / 2, innerHeight / 2); return p ? { block: p.block, state: p.state } : null; })();
return out;
