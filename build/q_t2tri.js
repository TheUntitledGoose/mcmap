// Which DRAWN mesh owns this one block? Walk every geometry in the scene and bill triangles whose
// bounding box overlaps the block's 1x1x1 box. This names the layer, so "the mesh key changed" stops
// being the evidence and "this triangle is still standing at this voxel" becomes it.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };

const HX = -59, HY = 72, HZ = -130;
const HCX = -4, HCZ = -9, PH_SEC = 100948;
w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(2000);

// Triangles overlapping the block box, grouped by mesh name.
function owners(bx, by, bz) {
  const lo = [bx - 0.002, by - 0.002, bz - 0.002], hi = [bx + 1.002, by + 1.002, bz + 1.002];
  const out = {};
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const pa = o.geometry.attributes.position;
    if (!pa) return;
    const p = pa.array;
    const ix = o.geometry.index ? o.geometry.index.array : null;
    const n = ix ? ix.length : p.length / 3;
    let hits = 0;
    for (let t = 0; t < n; t += 3) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = ix ? ix[t + k] : t + k;
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (maxX >= lo[0] && minX <= hi[0] && maxY >= lo[1] && minY <= hi[1] && maxZ >= lo[2] && minZ <= hi[2]) hits++;
    }
    if (hits) out[o.name || 'unnamed'] = (out[o.name || 'unnamed'] || 0) + hits;
  });
  return out;
}

const out = { block: [HX, HY, HZ], chunk: [HCX, HCZ] };
w.settings.timeTerrain = 0; w.timeGoto(PH_SEC); w.histSync(true); await settle(2500); w.timeGoto(PH_SEC);
out.present = owners(HX, HY, HZ);
out.presentDiag = (({ mk, installed, parked, suffix, stamp }) => ({ mk, installed, parked, suffix, stamp }))(w.meshDiag(HCX, HCZ));

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(4000); w.timeGoto(PH_SEC);
out.undo = owners(HX, HY, HZ);
out.undoDiag = (({ mk, installed, parked, suffix, stamp, markGen, histGen }) => ({ mk, installed, parked, suffix, stamp, markGen, histGen }))(w.meshDiag(HCX, HCZ));
out.hist = (({ chunks, edits, builds }) => ({ chunks, edits, builds }))(w.histStats());
out.mark = ((e) => (e ? { edits: e.edits.length / 2, truncated: e.truncated, gen: e.gen } : null))(w.HIST.marks.get(`${HCX},${HCZ}`));
out.errors = w.state.frameErrors;
return out;
