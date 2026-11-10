// M12b.7 acceptance for the new control: a viewer holding a remembered view gets back to what the page
// ships with in one click. Run against the SAME profile that build/q_m12b7_seed.js seeded, then re-run
// build/q_m12b7_check.js on it: a boot with nothing remembered.
// The button reloads the page, so every read here happens synchronously around the click.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!window.__world) { for (let i = 0; i < 200 && !window.__world; i++) await sleep(100); }
const w = window.__world;
const K = 'darkrpg.viewer.settings.v2';
const before = localStorage.getItem(K);
const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'forget view');
const out = {
  buttonFound: !!btn,
  hintMentionsReload: btn ? /reloads/.test(btn.title) : false,
  snapshotBeforeClick: before ? Object.keys(JSON.parse(before)).length : 0,
  ceilingInSnapshotBefore: before ? 'timeGeomMb' in JSON.parse(before) : null,
};
if (btn) btn.click();
out.snapshotAfterClick = localStorage.getItem(K);
out.hook = w.settingsStore ? { key: w.settingsStore().key, storable: w.settingsStore().storable.length,
  remembersCeiling: w.settingsStore().storable.includes('timeGeomMb') } : null;
out.ceilingNow = w.settings.timeGeomMb;
console.log(JSON.stringify(out));
