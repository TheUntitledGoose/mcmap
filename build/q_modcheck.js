// Decides "is the page running the code on disk?" without arguing about browser caches: fetch the module
// text the same way the import graph does, and grep it. Also sample a live mark object.
const w = window.__world;
const out = {};
for (const m of ['js/ledger-terrain.mjs', 'js/main.js']) {
  const t = await (await fetch(`/${m}`, { cache: 'no-store' })).text();
  out[m] = { bytes: t.length, changeRows: (t.match(/changeRows/g) || []).length, wasOf: (t.match(/wasOf/g) || []).length };
}
const marks = [...w.HIST.marks.values()];
out.marks = marks.length;
out.firstMark = marks.length ? { keys: Object.keys(marks[0]), changes: marks[0].changes, edits: marks[0].edits.length / 2 } : null;
out.totals = w.histTotals();
out.url = location.search;
return out;
