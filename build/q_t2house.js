// Does the house disappear? The user's framing, the user's playhead, and a raycast answer.
//
// The panel said "110 chunks, 6,761 blocks" while a whole house stood, and the log says the moment the
// playhead sat on (2024-06-01 23:00:38) has 82,874 place rows still in front of it, 1,690 of them in the
// chunk under the eye. So the replay owed that house to the user and did not pay.
//
// Answer with a raycast rather than pixels alone: the same screen point over a house wall must hit grass
// once the replay owns that chunk. Pixels back it up, and the mark distances prove the budget landed where
// the camera was looking.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };  // NOT a tight tick loop: worker results arrive as messages, and a synchronous loop starves them.
const out = {};
await sleep(0);                                   // browser-probe wraps a probe in an async IIFE only if it sees await

const PH_SEC = 100948;                            // 2024-06-01 23:00:38, base-relative, as the panel showed it
const SX = Math.round(innerWidth * 0.42), SY = Math.round(innerHeight * 0.45);   // a point on the house wall
w.setTimePlay(0);
w.settings.timeTiles = 0;                         // no decal: any change is a block
w.timeGoto(PH_SEC);

// Voxel truth in the store must not move: the replay draws copies, pick and collision keep the real world.
const truth = () => {
  let h = 0;
  for (let x = -56; x <= -20; x += 4) for (let y = 60; y <= 84; y += 4) for (let z = -136; z <= -108; z += 4) {
    h = (h * 31 + (w.at(x, y, z) | 0)) >>> 0;
  }
  return h;
};
out.truthBefore = truth();

const markDist = () => {
  const [cx, cz] = [-3, -9];
  const d = [...w.HIST.marks.keys()].map((k) => {
    const [a, b] = k.split(',').map(Number);
    return Math.max(Math.abs(a - cx), Math.abs(b - cz));
  }).sort((p, q) => p - q);
  return { n: d.length, near: d[0] ?? null, median: d[d.length >> 1] ?? null, far: d[d.length - 1] ?? null,
    within3: d.filter((v) => v <= 3).length };
};

const shot = () => { w.tick(1); const g = w.grab(); return g.buf; };
const pick = () => { const p = w.pickState(SX, SY); return p ? { block: p.block, state: p.state, drawn: p.drawn } : null; };

w.settings.timeTerrain = 0; w.histSync(true); await settle();
w.timeGoto(PH_SEC);
const off = { pick: pick(), verts: w.state.detailVerts, totals: w.histTotals(), marks: markDist(),
  stats: { marked: w.histStats().marked, capped: w.histStats().capped, truncated: w.histStats().truncated } };
const fbOff = shot();

w.settings.timeTerrain = 1; w.histSync(true); await settle();
w.timeGoto(PH_SEC); await settle(800);
const on = { pick: pick(), verts: w.state.detailVerts, totals: w.histTotals(), marks: markDist(),
  stats: { marked: w.histStats().marked, capped: w.histStats().capped, truncated: w.histStats().truncated,
    truncChunks: w.histStats().truncChunks, builds: w.histStats().builds, err: w.histStats().err } };
const fbOn = shot();
out.off = off;
out.on = on;

let changed = 0, darkOff = 0, darkOn = 0;
for (let i = 0; i < Math.min(fbOn.length, fbOff.length); i += 4) {
  const d = Math.abs(fbOn[i] - fbOff[i]) + Math.abs(fbOn[i + 1] - fbOff[i + 1]) + Math.abs(fbOn[i + 2] - fbOff[i + 2]);
  if (d > 24) changed++;
  if (fbOff[i] < 70 && fbOff[i + 1] < 70 && fbOff[i + 2] < 80) darkOff++;
  if (fbOn[i] < 70 && fbOn[i + 1] < 70 && fbOn[i + 2] < 80) darkOn++;
}
out.pixels = { changed, of: fbOff.length / 4, darkHousePixelsOff: darkOff, darkHousePixelsOn: darkOn };
out.truthAfter = truth();
out.note = w.histNote();
out.errors = { page: w.state.bootError ?? null, frames: w.state.frameErrors ?? 0 };
return out;
