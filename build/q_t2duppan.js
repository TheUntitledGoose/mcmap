// The same bug on the ordinary path: every re-cut that did not drop its predecessor leaves a second mesh
// drawing the same chunk. Pan and count, with the time machine OFF, so nothing here is history-related.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
await settle(4000);
function tally() {
  const seen = new Map();
  let dup = 0, dupVerts = 0, meshes = 0, verts = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || o.name !== 'detail0' || !o.visible || !o.geometry) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const k = [g.boundingBox.min.x, g.boundingBox.min.z, g.boundingBox.max.x, g.boundingBox.max.z].join(',');
    const v = g.attributes.position.count;
    meshes++; verts += v;
    if (seen.has(k)) { dup++; dupVerts += v; } else seen.set(k, v);
  });
  return { chunks: seen.size, meshes, dup, dupVerts, verts, stateVerts: w.state.detailVerts };
}
const out = { timeMachine: w.settings.time ? 1 : 0, terrain: w.histWanted() ? 1 : 0, before: tally() };
const [x0, , z0] = Array.from(w.state.target);
for (let i = 1; i <= 8; i++) { w.go(x0 + i * 24, 72, z0 + i * 24); await sleep(120); }
await settle(6000);
out.afterPan = tally();
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
