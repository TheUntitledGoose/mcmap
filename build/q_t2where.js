// Two suspects for the 0-pixel A/B, answered in one pass.
//  (a) histSync spends timeTerrainMax on a square walked from its far corner, so the chunk under the
//      camera may never be marked; and
//  (b) the edits that ARE built sit underground, where the dark-face cull already hides their faces.
// This reports where the marks are relative to the camera chunk, and for the camera chunk how many of
// its edit voxels have air above them in the store payload.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 240) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
await sleep(0);
const out = {};
w.setTimePlay(0);
w.timeSeekRow(0);
w.settings.timeTerrain = 1;
w.histSync(true);
await settle();
const CCX = Math.floor(-236 / 16), CCZ = Math.floor(137 / 16);
const marks = [...w.HIST.marks.keys()];
const dist = marks.map((k) => { const [x, z] = k.split(',').map(Number); return Math.max(Math.abs(x - CCX), Math.abs(z - CCZ)); });
dist.sort((a, b) => a - b);
out.marks = { n: marks.length, capped: w.histStats().capped, near: dist[0], median: dist[dist.length >> 1], far: dist[dist.length - 1],
  cameraChunkMarked: dist[marks.indexOf(`${CCX},${CCZ}`)] ?? null,
  within2: dist.filter((d) => d <= 2).length };
const m = w.histEditsOf(CCX, CCZ);
const tot = { edits: 0, airAbove: 0, airAbove3: 0, max: 0, min: 0 };
if (m) {
  for (let i = 0; i < m.edits.length; i += 2) {
    const c = m.edits[i], st = m.edits[i + 1];
    const x = CCX * 16 + (c & 15), z = CCZ * 16 + ((c >> 4) & 15), y = ((c >> 8) & 0x1fff) - 4096;
    tot.edits++;
    if (y > tot.max) tot.max = y;
    if (!tot.min || y < tot.min) tot.min = y;
    const up = w.at(x, y + 1, z);
    if (up && up === w.at(x, y + 3, z)) { tot.airAbove++; if (w.surfaceY) tot.airAbove3++; }
  }
}
out.cameraChunk = { cx: CCX, cz: CCZ, stamp: w.histStampOf(CCX, CCZ), ...tot,
  groundHere: w.columnTop ? w.columnTop(CCX, CCZ) : null };
const s = w.histStats();
out.built = { chunks: s.chunks, edits: s.edits, changes: s.changes, builds: s.builds, patches: s.patches,
  skipped: s.skipped, verts: w.state.detailVerts };
return out;
