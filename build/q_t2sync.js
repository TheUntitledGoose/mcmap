// The centre-out mark walk replaced a square walk, so its cost is now a number to check, not a hope.
// Time a FORCED sync (the whole scan, at a settled playhead) at several moments of the log, and say what
// each sync bought: fresh marks, restored marks, and whether the cap was hit.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const rows = w.time().rows;
const out = {
  framing: Array.from(w.state.target), dist: Math.round(w.state.dist),
  detailVerts: w.state.detailVerts, meshes: w.state.meshes,
  settings: { time: w.state.time, terrain: w.histWanted() ? 1 : 0, cap: w.hist().cap,
              limit: w.settings.timeTerrainLimit, cls: w.time().cls, who: w.ledger().who },
};
await settle(5000);

out.stops = [];
for (const frac of [0, 0.5, 1]) {
  w.timeSeekRow(Math.round(rows * frac));
  await settle(3500);
  const samples = [];
  for (let i = 0; i < 6; i++) { w.histSync(true); w.tick(1); samples.push(w.hist().syncMs); }
  const h = w.hist();
  out.stops.push({
    frac, sec: w.time().sec, cur: Math.round(w.time().cur),
    syncMsMedian: samples.slice().sort((a, b) => a - b)[3],
    syncMsMax: Math.max(...samples),
    marked: h.marked, restore: h.restore, capped: h.capped,
    chunks: h.chunks, edits: h.edits, changes: h.changes, truncated: h.truncated,
    builds: h.builds, verts: w.state.detailVerts,
  });
}
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
