// 12b.5: put the pixel A/B on a change voxel the camera can actually see.
//
// The first attempt framed a trampled voxel that turned out to be buried (dirt at y 63 under
// polished_diorite at y 64), so undoing it changed nothing on screen and "changed: 0" was read as
// "the feature does nothing". A logged block change only shows up when the voxel it names is the top
// block of its column, so ask the page for one: surfaceY(x, z) === y + 1.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 200) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(20); };
const out = {};
await sleep(0);                                   // browser-probe wraps a probe in an async IIFE only if it sees await

out.settings = { cls: w.settings.timeCls, terrain: w.settings.timeTerrain, tiles: w.settings.timeTiles,
  who: w.settings.ledgerWho, limit: w.settings.timeTerrainLimit };

// Every voxel the current filter touches. Keep the changes that sit at the top of their column.
const idx = w.timeVoxelIndex();
const cand = [];
for (const v of idx) {
  for (const t of v.t) {
    if (!w.histStampOf(v.cx, v.cz)) continue;
    const top = w.surfaceY(v.x, v.z);
    if (top !== v.y + 1) continue;              // buried: undoing it moves no pixel
    cand.push({ x: v.x, y: v.y, z: v.z, cx: v.cx, cz: v.cz, t });
    break;
  }
  if (cand.length >= 8) break;
}
out.candidates = cand.map((c) => ({ x: c.x, y: c.y, z: c.z, cx: c.cx, cz: c.cz,
  rows: c.t.map((e) => `${e.c}@${e.t}`), top: w.surfaceY(c.x, c.z) }));
if (!cand.length) { out.found = 0; return out; }
out.found = cand.length;

// Aim at the first candidate from above, close enough that it is a good fraction of the frame.
const c = cand[0];
w.go(c.x + 0.5, c.y, c.z + 0.5);
w.orbit(0.6, 1.1, 14);
w.timeSeekRow(0);                                // before every logged change: every one of them undone
w.settings.timeTerrain = 1;
w.histSync(true);
await settle();
const grab = () => { w.tick(1); return w.grab().buf; };
const A = grab();
out.on = w.histStats();
w.settings.timeTerrain = 0;
w.histSync(true);
await settle();
const B = grab();
let changed = 0, dr = 0, dg = 0;
const n = Math.min(A.length, B.length);
for (let i = 0; i < n; i += 4) {
  const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  if (d > 12) changed++;
  dr += A[i] - B[i]; dg += A[i + 1] - B[i + 1];
}
out.pixels = { changed, of: n / 4, meanRDiff: +(dr / (n / 4)).toFixed(3), meanGDiff: +(dg / (n / 4)).toFixed(3),
  detailVerts: w.state.detailVerts };
w.settings.timeTerrain = 1; w.histSync(true);
out.errors = { page: w.state.bootError ?? null, frames: w.state.frameErrors ?? 0 };
return out;
