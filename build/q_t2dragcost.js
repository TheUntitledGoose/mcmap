// What the live playhead costs. Before this, dragging moved nothing until release and the date refreshed
// once a second; now every input event moves the cursor, and every playhead move repaints five rows and two
// sentences. Measure both gesture paths at the framing where terrain undo is actually running.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const row = [...document.querySelectorAll('.panel-row')].find((x) => /playhead/i.test(x.textContent || ''));
const sl = row.querySelector('input[type=range]');
const out = { settings: { time: w.state.time, terrain: w.histWanted() ? 1 : 0, step: w.hist().step,
  cap: w.hist().cap, timeCls: w.time().cls } };
await settle(180);
out.boot = { fps: +w.state.fps.toFixed(1), verts: w.state.detailVerts, chunks: w.state.chunks };

// Playback: 18 s of the whole overworld place log at 20,000 changes/s, sampled as it runs.
w.timeSeekRow(0); await settle(30);
w.set('timePlay', 1);
const t0 = performance.now();
const play = [];
for (let i = 0; i < 60; i++) {
  for (let k = 0; k < 10; k++) { await raf(); w.tick(1); }
  play.push([Math.round(performance.now() - t0), Math.round(w.time().cur), w.time().drawn, +w.state.fps.toFixed(1)]);
  if (!w.time().playing) break;
}
out.play = { samples: play.slice(0, 3).concat(play.slice(-3)), fpsMin: Math.min(...play.map((p) => p[3])),
  fpsMax: Math.max(...play.map((p) => p[3])), rows: Math.round(w.time().cur), wallMs: Math.round(performance.now() - t0) };
w.set('timePlay', 0);

// Drag: 120 input events at roughly one per frame, the way a pointer moves.
w.timeSeekRow(0); await settle(60);
const t1 = performance.now();
let moved = 0, fpsMin = 1e9, fpsMax = 0;
for (let i = 0; i <= 120; i++) {
  sl.value = String(Math.round((i / 120) * 1000));
  sl.dispatchEvent(new Event('input', { bubbles: true }));
  await raf(); w.tick(1);
  const f = w.state.fps;
  fpsMin = Math.min(fpsMin, f); fpsMax = Math.max(fpsMax, f);
  moved = Math.round(w.time().cur);
}
sl.dispatchEvent(new Event('change', { bubbles: true }));
await settle(60);
out.drag = { events: 121, wallMs: Math.round(performance.now() - t1), endCur: moved,
  fpsMin: +fpsMin.toFixed(1), fpsMax: +fpsMax.toFixed(1), date: (row.querySelector('.panel-val')?.textContent || '').trim(),
  hist: { chunks: w.hist().chunks, marked: w.hist().marked, edits: w.hist().edits, builds: w.hist().builds } };
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
