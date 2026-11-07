// An explicit choice must win. `?timeterrain=0` is the viewer saying "no" to the voxel undo, so turning the
// time machine off and on again may not quietly re-arm a cost that was just turned off.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 1500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
await settle(2500);
const out = { url: { time: w.settings.time, terrain: w.settings.timeTerrain, touched: w.settings.timeTouched },
  bootWanted: w.histWanted() ? 1 : 0 };
w.set('time', 0); await settle(800);
w.set('time', 1); await settle(2500);
out.afterOffOn = { time: w.time().on, terrain: w.histWanted() ? 1 : 0, touched: w.settings.timeTouched };
// and the checkbox itself is still a choice the page honours both ways
w.set('timeTerrain', 1); await settle(1200);
out.afterCheckbox = { terrain: w.histWanted() ? 1 : 0, chunks: w.hist().chunks, edits: w.hist().edits };
w.set('timeTerrain', 0); await settle(800);
out.afterCheckboxOff = { terrain: w.histWanted() ? 1 : 0 };
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
