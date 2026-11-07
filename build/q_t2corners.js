// Page-side twin of build/dbg-housimesh.mjs: count DRAWN VERTICES whose position falls inside one
// block's box. Node says present 72 -> undone 0 for this voxel. If the page says 72 -> 72, the mesh
// installed in the browser is not the patched one.
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
function corners(bx, by, bz) {
  let n = 0;
  const per = {};
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const g = o.geometry, pa = g.attributes.position;
    if (!pa) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const c = g.boundingSphere.center, r = g.boundingSphere.radius;
    if (c.x + r < bx - EPS || c.x - r > bx + 1 + EPS) return;
    if (c.z + r < bz - EPS || c.z - r > bz + 1 + EPS) return;
    if (c.y + r < by - EPS || c.y - r > by + 1 + EPS) return;
    const p = pa.array;
    let h = 0;
    for (let v = 0, m = pa.count; v < m; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (x < bx - EPS || x > bx + 1 + EPS) continue;
      if (y < by - EPS || y > by + 1 + EPS) continue;
      if (z < bz - EPS || z > bz + 1 + EPS) continue;
      h++;
    }
    if (h) { n += h; per[o.name || 'unnamed'] = (per[o.name || 'unnamed'] || 0) + h; }
  });
  return { n, per };
}

const out = { block: [HX, HY, HZ], settingNames: Object.keys(w.settings).filter((k) => /time/i.test(k)) };
w.settings.timeTerrain = 0; w.timeGoto(PH_SEC); w.histSync(true); await settle(3000); w.timeGoto(PH_SEC);
out.terrainOff = corners(HX, HY, HZ);
out.offHist = (({ on, wanted, sec, chunks, edits, builds }) => ({ on, wanted, sec, chunks, edits, builds }))(w.histStats());
out.offDiag = (({ mk, installed, parked, suffix }) => ({ suffix, parked, same: mk === installed }))(w.meshDiag(HCX, HCZ));

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(4000); w.timeGoto(PH_SEC);
out.terrainOn = corners(HX, HY, HZ);
out.onHist = (({ on, wanted, sec, chunks, edits, builds, workerPatches, patches }) => ({ on, wanted, sec, chunks, edits, builds, workerPatches, patches }))(w.histStats());
out.onDiag = (({ mk, installed, parked, suffix, markGen, histGen }) => ({ suffix, parked, same: mk === installed, markGen, histGen }))(w.meshDiag(HCX, HCZ));
out.errors = w.state.frameErrors;
return out;
