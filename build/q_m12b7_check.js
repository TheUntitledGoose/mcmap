// M12b.7 evidence, step 2 of 2: boot a fresh page against the profile that build/q_m12b7_seed.js left a
// remembered snapshot in, arm the time machine the way a viewer would (the M key, no URL parameters),
// and report what shape the replay actually gets.
// The snapshot being tested says "128 MB ceiling, flat tiles" - the values the panel shipped before the
// replay was priced as blocks. A page that inherits them draws plates; a page that retires them draws
// the block itself.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await raf(); await sleep(16); }
};
if (!window.__world) { for (let i = 0; i < 200 && !window.__world; i++) await sleep(100); }
const w = window.__world;
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } };
const seeded = { v1: read('darkrpg.viewer.settings.v1'), v2: read('darkrpg.viewer.settings.v2') };
const store = w.settingsStore ? w.settingsStore() : null;
const beforeCeiling = w.settings.timeGeomMb;
const beforeLook = w.settings.timeLook;
await settle(1200);
w.setTime(1);                                   // the M key: the checkbox path, not a URL
for (let i = 0; i < 200 && !(w.TLAYER.tl && w.TLAYER.quads); i++) await sleep(100);
w.setTimePlay(0);
w.timeSeekRow(Math.max(0, w.TLAYER.quads - 1)); // park at the end: every change the filter holds drawn
await settle(2500);
const t = w.time();
console.log(JSON.stringify({
  seededV1ceiling: seeded.v1 ? seeded.v1.timeGeomMb : null,
  seededV1look: seeded.v1 ? seeded.v1.timeLook : null,
  seededV2ceiling: seeded.v2 ? seeded.v2.timeGeomMb : null,
  seededV2look: seeded.v2 ? seeded.v2.timeLook : null,
  storeKey: store ? store.key : null,
  storeRemembersCeiling: store ? store.storable.includes('timeGeomMb') : null,
  storableCount: store ? store.storable.length : null,
  ceilingAtBoot: beforeCeiling, lookAtBoot: beforeLook,
  look: t.look, want: t.lookWant, ceiling: t.geomMbCap, lookBytes: t.lookBytes,
  why: t.lookWhy, quads: t.quads, drawn: t.drawn, markerGeoMb: t.markerGeoMb,
  verts: w.state.verts, fps: +w.state.fps.toFixed(1),
}));
