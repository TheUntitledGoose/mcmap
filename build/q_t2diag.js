// Why did the blocks stop changing when the playhead moves? Name the members of every counter.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n = 90) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const out = {};
const st = () => w.state;
const hist = () => w.hist();

out.atBoot = { hist: hist(), tl: { cur: w.__t?.cur, quads: w.timeInfo?.()?.quads } };
w.set('time', 1);
await settle(120);
w.timeSeekRow(0);
await settle(150);

// what the sync layer believes
const h = hist();
out.afterSeekRow0 = {
  on: h.on, wanted: h.wanted, sec: h.sec, cur: h.cur, gen: h.gen,
  touched: h.touched, marked: h.marked, capped: h.capped, skipped: h.skipped,
  chunks: h.chunks, edits: h.edits, unknown: h.unknown, truncated: h.truncated,
  builds: h.builds, buildTotal: h.buildTotal, patches: h.patches, step: h.step, cap: h.cap, limit: h.limit,
  err: h.err,
};
// name the members: what does each mark hold?
const marks = [];
for (const [k, e] of (w.HIST?.marks ?? new Map())) {
  marks.push({ k, gen: e.gen, edits: e.edits.length >> 1, unknown: e.unknown, trunc: e.truncated ? 1 : 0 });
}
marks.sort((a, b) => b.edits - a.edits);
out.marks = { n: marks.length, gens: [...new Set(marks.map((m) => m.gen))], histGen: w.HIST?.gen,
  top: marks.slice(0, 6), zeroEdits: marks.filter((m) => !m.edits).length, nonempty: marks.filter((m) => m.edits).length };
out.byCell = { has: !!w.HIST?.byCell, size: w.HIST?.byCell?.size ?? null,
  idsSize: w.HIST?.ids ? (w.HIST?.ids?.size ?? 'map?') : null, airId: w.HIST?.airId };
out.tl = w.timeInfo?.() ?? null;

// does the sharp mesh actually differ when the switch flips, at THIS framing?
const a = st(), ma = hist();
w.set('timeTerrain', 0);
await settle(150);
const b = st(), mb = hist();
w.set('timeTerrain', 1);
await settle(150);
const c = st(), mc = hist();
out.switch = {
  verts: [a.verts, b.verts, c.verts], tris: [a.tris, b.tris, c.tris],
  calls: [a.calls, b.calls, c.calls],
  edits: [ma.chunks, mb.chunks, mc.chunks].map((x, i) => [x, [ma, mb, mc][i].edits]),
  marksNow: hist().marked, buildsNow: hist().builds,
};
out.framing = { dist: Math.round(w.state.target ? w.dist?.() ?? -1 : -1), keys: w.panelKeys ? 1 : 0 };
out.frameErrors = w.frameErrors ?? null;
return out;
