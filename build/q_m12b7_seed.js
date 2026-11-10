// M12b.7 evidence, step 1 of 2 (run with --profile <dir> --keep-profile, then build/q_m12b7_check.js
// against the SAME profile): write the snapshot an older viewer would already be holding.
// The values are the ones the panel shipped before the replay was priced as blocks: a 128 MB overlay
// ceiling, and the flat-tile look that was the ONLY look then.
//   ?seed=v1  -> only the old key exists, which is the state a real viewer is in after the fix ships
//   ?seed=v2  -> both keys exist, which tests that a fresh snapshot still cannot carry a ceiling
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!window.__world) { for (let i = 0; i < 200 && !window.__world; i++) await sleep(100); }
const w = window.__world;
const mode = new URLSearchParams(location.search).get('seed') || 'v1';
// 'blocks' is the look Tier 3 shipped with, so it is what a viewer who never touched the row holds;
// 'tiles' is the look that existed before Tier 3, so it is what an older snapshot holds.
const look = new URLSearchParams(location.search).get('look') || 'tiles';
const snap = { timeGeomMb: 128, timeLook: look, timeTiles: 1, timeCls: 0, timeTerrain: 1, decalop: 0.45 };
localStorage.removeItem('darkrpg.viewer.settings.v1');
localStorage.removeItem('darkrpg.viewer.settings.v2');
localStorage.setItem('darkrpg.viewer.settings.v1', JSON.stringify(snap));
if (mode === 'v2') localStorage.setItem('darkrpg.viewer.settings.v2', JSON.stringify(snap));
console.log(JSON.stringify({
  mode, wrote: snap,
  left: {
    v1: !!localStorage.getItem('darkrpg.viewer.settings.v1'),
    v2: !!localStorage.getItem('darkrpg.viewer.settings.v2'),
  },
  store: w.settingsStore ? w.settingsStore() : 'no settingsStore hook',
  ceilingAtBootThisRun: w.settings.timeGeomMb,
}));
