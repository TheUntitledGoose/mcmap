// Pixel proof for the block-change class: at one playhead, with the change tiles switched off, the ONLY
// difference between the two frames is terrain that a logged block-change row put back. grass_block and
// dirt are both full cubes, so a vertex bill cannot see this difference at all (-180 verts); greenness can.

const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 240) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(20); };
const out = {};
await sleep(0);                                   // browser-probe wraps a probe in an async IIFE only if it sees await

// `__world.settings` is the live S the panel writes; `__world.state` is the stats object. Reading the
// wrong one used to make an A/B report "changed: 0" while the toggle never happened.
out.settings = { cls: w.settings.timeCls, terrain: w.settings.timeTerrain, tiles: w.settings.timeTiles,
  who: w.settings.ledgerWho, limit: w.settings.timeTerrainLimit, playhead: w.time().at,
  tilesDrawn: w.time().drawn, detailChunks: w.state.detailChunks ?? null };

// Grass turning to dirt is a surface change, so the honest framing is a wide one: 33,901 logged block
// changes fall inside the spawn skin. Tiles are off, so any pixel that moves is a block.
const grab = () => { w.tick(1); return w.grab().buf; };
const green = (b) => { let n = 0; for (let i = 0; i < b.length; i += 4) if (b[i + 1] > 110 && b[i + 1] > b[i] + 18) n++; return n; };
const brown = (b) => { let n = 0; for (let i = 0; i < b.length; i += 4) {
  const r = b[i], g = b[i + 1], bb = b[i + 2];
  if (r > 70 && r < 150 && g > 45 && g < 110 && bb < 80 && r > g + 25) n++; } return n; };
const det = () => w.state.detailVerts;

w.timeSeekRow(0); w.settings.timeTerrain = 1; w.histSync(true); settle();
const A = grab(), detA = det();
w.settings.timeTerrain = 0; w.histSync(true); settle();
const B = grab(), detB = det();
let changed = 0, dr = 0;
const n = Math.min(A.length, B.length);
for (let i = 0; i < n; i += 4) {
  const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
  if (d > 12) changed++;
  dr += A[i + 1] - B[i + 1];
}
out.pixels = { changed, greenA: green(A), greenB: green(B), brownA: brown(A), brownB: brown(B),
  meanGDiff: +(dr / (n / 4)).toFixed(3), total: n / 4, detailVertsOff: detB, detailVertsOn: detA };
out.terrainOn = w.histStats();
out.note = w.histNote();
w.settings.timeTerrain = 1; w.histSync(true);
out.errors = { page: w.state.bootError ?? null, frames: w.state.frameErrors ?? 0 };
return out;
