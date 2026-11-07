// Fresh-page A/B of the time machine at the framing of the user's screenshot: same camera, same
// playhead, only the block-undo switch differs. The probe tool takes the screenshot.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
const PH_SEC = 100948;                     // 2024-06-01 23:00:38 local, the moment in the screenshot
w.setTimePlay(0);
w.go(-59, 72, -130);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3000);
await settle(4000);
w.tick(1);
const EPS = 1e-3;
let corners = 0;
w.scene.traverse((o) => {
  if (!o.isMesh || !o.visible || !o.geometry) return;
  const g = o.geometry, pa = g.attributes.position;
  if (!pa) return;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox;
  if (bb.max.x < -59.001 || bb.min.x > -58 + 0.001 || bb.max.z < -130.001 || bb.min.z > -129 + 0.001
    || bb.max.y < 71.999 || bb.min.y > 73.001) return;
  const p = pa.array;
  for (let v = 0, m = pa.count; v < m; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    if (x < -59.001 || x > -58 + 0.001) continue;
    if (y < 72 - 0.001 || y > 73 + 0.001) continue;
    if (z < -130.001 || z > -129 + 0.001) continue;
    corners++;
  }
});
let dup = 0;
{
  const seen = new Set();
  w.scene.traverse((o) => {
    if (o.isMesh && o.name === 'detail0' && o.visible && o.geometry) {
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const k = [g.boundingBox.min.x, g.boundingBox.min.z, g.boundingBox.max.x, g.boundingBox.max.z].join(',');
      if (seen.has(k)) dup++; else seen.add(k);
    }
  });
}
return { terrain: w.settings.timeTerrain, wallVoxelCorners: corners, duplicateDetailMeshes: dup,
  hist: (({ on, chunks, edits, builds, marked, restore, capped }) => ({ on, chunks, edits, builds, marked, restore, capped }))(w.histStats()),
  detailMeshes: w.state.detailMeshes, detailVerts: w.state.detailVerts, date: w.time().label ?? w.time().date ?? null,
  time: w.time(), errors: w.state.frameErrors };
