// Which meshes put vertices inside this block box, and where does each one think it is? Two detail
// meshes covering the same block would explain why patching one chunk leaves the wall standing.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };

const HX = -59, HY = 72, HZ = -130;
const HCX = -4, HCZ = -9, PH_SEC = 100948;
w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(2500);

const EPS = 1e-3;
function who(bx, by, bz) {
  const hits = [];
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const g = o.geometry, pa = g.attributes.position;
    if (!pa) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb.max.x < bx - EPS || bb.min.x > bx + 1 + EPS) return;
    if (bb.max.z < bz - EPS || bb.min.z > bz + 1 + EPS) return;
    if (bb.max.y < by - EPS || bb.min.y > by + 1 + EPS) return;
    const p = pa.array;
    let h = 0;
    for (let v = 0, m = pa.count; v < m; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (x < bx - EPS || x > bx + 1 + EPS) continue;
      if (y < by - EPS || y > by + 1 + EPS) continue;
      if (z < bz - EPS || z > bz + 1 + EPS) continue;
      h++;
    }
    if (h) hits.push({ name: o.name, verts: pa.count, idx: g.index ? g.index.count : 0,
      box: [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map((v) => Math.round(v * 100) / 100),
      corners: h, parent: o.parent ? o.parent.name || String(o.parent.type) : null });
  });
  return hits;
}

const out = { block: [HX, HY, HZ] };
w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(4000); w.timeGoto(PH_SEC);
out.undo = who(HX, HY, HZ);
w.settings.timeTerrain = 0; w.histSync(true); await settle(3000); w.timeGoto(PH_SEC);
out.present = who(HX, HY, HZ);
out.diagUndo = ((d) => d)(w.meshDiag(HCX, HCZ));
out.errors = w.state.frameErrors;
return out;
