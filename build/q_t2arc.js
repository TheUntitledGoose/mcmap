// The claim the user needs to see: scrub the playhead and the house gets BUILT. One camera, three
// moments, and a count of the drawn vertices inside the house's own box (chunk -4,-9, y 66..92).
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(-59, 72, -130);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3000);

const EPS = 1e-3, BX0 = -64, BX1 = -48, BZ0 = -144, BZ1 = -128, BY0 = 66, BY1 = 92;
function houseCorners() {
  let n = 0, meshes = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry || !/^detail/.test(o.name || '')) return;
    const g = o.geometry, pa = g.attributes.position;
    if (!pa) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb.max.x < BX0 - EPS || bb.min.x > BX1 + EPS || bb.max.z < BZ0 - EPS || bb.min.z > BZ1 + EPS
      || bb.max.y < BY0 - EPS || bb.min.y > BY1 + EPS) return;
    const p = pa.array;
    let h = 0;
    for (let v = 0, m = pa.count; v < m; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (x < BX0 - EPS || x > BX1 + EPS) continue;
      if (z < BZ0 - EPS || z > BZ1 + EPS) continue;
      if (y < BY0 - EPS || y > BY1 + EPS) continue;
      h++;
    }
    if (h) { n += h; meshes++; }
  });
  return { n, meshes };
}

function dupCount() {
  const seen = new Set();
  let dup = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || o.name !== 'detail0' || !o.visible || !o.geometry) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const k = [g.boundingBox.min.x, g.boundingBox.min.z, g.boundingBox.max.x, g.boundingBox.max.z].join(',');
    if (seen.has(k)) dup++; else seen.add(k);
  });
  return dup;
}

const t = w.time();
const rows = t.quads;
const stops = [
  { at: 0, row: 0 },
  { at: 100948, row: null },
  { at: 'end', row: rows - 1 },
];
const out = { rows, dupStart: dupCount(), stops: [] };
for (const s of stops) {
  if (s.row === null) w.timeGoto(s.at); else w.timeSeekRow(s.row);
  w.histSync(true);
  await settle(4000);
  const c = houseCorners();
  const h = w.histStats();
  out.stops.push({ label: s.at === 'end' ? 'end' : s.at, timeAt: w.time().at, sec: w.time().sec,
    houseBoxCorners: c.n, houseBoxMeshes: c.meshes, dup: dupCount(),
    hist: { on: h.on, chunks: h.chunks, edits: h.edits, builds: h.builds, marked: h.marked, capped: h.capped },
    note: w.histNote().slice(0, 200) });
}
out.errors = w.state.frameErrors;
return out;
