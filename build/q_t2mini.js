const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const out = {};
for (let i = 0; i < 240 && !w.time().tl && !w.time().err; i++) await raf();
w.go(-40, 72, -120); w.orbit(0.7, 0.9, 150); await settle(90);
const Q = w.time().quads;
w.timeSeekRow(Q - 1); w.histSync(true); await settle(60);
out.atEnd = { meshed: w.state.meshed, dirty: w.state.dirty, hist: w.hist(), verts: w.state.verts };
w.timeSeekRow(0);
out.justAfterJump = { marked: w.hist().marked, gen: w.hist().gen, dirty: w.state.dirty, meshed: w.state.meshed };
const trace = [];
for (let f = 0; f < 40; f++) {
  await raf(); w.tick(1);
  const s = w.state, h = w.hist();
  if (f % 4 === 0 || f < 6) trace.push({ f, meshed: s.meshed, dirty: s.dirty, queued: s.meshQueued, chunksPatched: h.chunks, edits: h.edits, wp: h.workerPatches });
}
out.trace = trace;
out.after = { meshed: w.state.meshed, hist: w.hist(), verts: w.state.verts, note: w.histNote() };
out.loud = { atEnd: (() => { w.timeSeekRow(Q - 1); w.histSync(true); const e = w.histEditsOf(-3, -8); return { edits: e.edits.length / 2, stamp: w.histStampOf(-3, -8) }; })() };
out.truthSample = [w.at(-43, 84, -123), w.at(-43, 83, -123), w.at(-43, 65, -123), w.at(-46, 58, -126)];
out.stored = w.state.chunks;
return out;
