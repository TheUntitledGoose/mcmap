// Settle, then report. Used for the two screenshots of the terrain time machine (undo on / undo off) at
// the same camera and the same playhead: the only difference between the files is the one switch.
const raf = () => new Promise((res) => requestAnimationFrame(res));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const w = window.__world;
w.timeSeekRow(0);
w.go(-40, 72, -120); w.orbit(-1.05, 0.95, 1500);
for (let i = 0; i < 240; i++) { await raf(); w.tick(1); }
await sleep(400);
for (let i = 0; i < 60; i++) { await raf(); w.tick(1); }
const h = w.hist();
return {
  state: w.state, hist: h, note: w.histNote(),
  panel: w.panelKeys().includes('timeTerrain'),
};
