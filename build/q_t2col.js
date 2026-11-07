// Column profile of DRAWN triangles: for each block in a column, how many triangles lie inside that
// block's own 1x1x1 box. With the replay on, the blocks it undoes must stop having faces.
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

const EPS = 0.02;
function profile(bx, bz, y0, y1) {
  // Gather candidate geometry once: any mesh whose bounding box touches this column.
  const cand = [];
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const g = o.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const c = g.boundingSphere.center, r = g.boundingSphere.radius;
    if (c.x + r < bx - EPS || c.x - r > bx + 1 + EPS) return;
    if (c.z + r < bz - EPS || c.z - r > bz + 1 + EPS) return;
    if (c.y + r < y0 - EPS || c.y - r > y1 + 1 + EPS) return;
    cand.push(o);
  });
  const rows = {};
  for (const o of cand) {
    const p = o.geometry.attributes.position.array;
    const ix = o.geometry.index ? o.geometry.index.array : null;
    const n = ix ? ix.length : p.length / 3;
    for (let t = 0; t < n; t += 3) {
      let x0 = Infinity, x1 = -Infinity, yA = Infinity, yB = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = ix ? ix[t + k] : t + k;
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < yA) yA = y; if (y > yB) yB = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      // fully inside one block box of this column
      if (x0 >= bx - EPS && x1 <= bx + 1 + EPS && z0 >= bz - EPS && z1 <= bz + 1 + EPS) {
        const by = Math.floor((yA + yB) / 2 + 1e-4);
        if (by >= y0 && by <= y1) {
          const key = `${o.name}|${by}`;
          rows[key] = (rows[key] || 0) + 1;
        }
      }
    }
  }
  const geos = cand.map((o) => `${o.name}:${o.geometry.uuid.slice(0, 6)}:${o.geometry.attributes.position.count}`);
  return { geos, rows };
}

const out = { block: [HX, HY, HZ], keys: Object.keys(w).filter((k) => /store|chunk|payload|patch|hist/i.test(k)) };
w.settings.timeTerrain = 0; w.timeGoto(PH_SEC); w.histSync(true); await settle(2500); w.timeGoto(PH_SEC);
const a = profile(HX, HZ, HY - 12, HY + 12);
out.present = { geos: a.geos, rows: a.rows };

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(4000); w.timeGoto(PH_SEC);
const b = profile(HX, HZ, HY - 12, HY + 12);
out.undo = { geos: b.geos, rows: b.rows };
out.sameGeometry = a.geos.join(',') === b.geos.join(',');
out.errors = w.state.frameErrors;
return out;
