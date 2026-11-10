// "I see the green 2D tile of the placement but no voxel block." Where does the VOXEL half of the time
// machine stop applying? Bucket every DRAWN change marker by what the page can actually do to its voxel,
// then look at individual voxels and ask which layer has geometry inside the block box.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};

w.setTimePlay(0);
await settle(1500);
out.boot = { time: w.time().on, look: w.time().look, terrain: w.settings.timeTerrain };

// The screenshot sat at 27,656 of 331,040 drawn changes. Put the cursor there.
const row = Math.min(w.TLAYER.quads - 1, 27655);
out.seek = { row, drawn: w.timeSeekRow(row), sec: w.time().sec, at: w.time().at };
await settle(2500);

const d = w.state;
out.frame = { dist: d.dist, target: d.target, detailRadius: d.detailRadius, detailMeshes: d.detailMeshes,
  payloadRadius: d.payloadRadius, detailPx: d.detailPx, detailReachBlocks: d.detailReachBlocks,
  shellTiers: d.shellTiers, skinRadius: d.skinRadius, verts: d.verts,
  lodVerts: d.lodVerts, lodMeshes: d.lodMeshes, shellVerts: d.shellVerts, ovVerts: d.ovVerts };
out.hist = { ...w.hist() };
out.totals = w.histTotals();
out.time = { drawn: w.time().drawn, quads: w.time().quads, look: w.time().look, lookWhy: w.time().lookWhy,
  unknown: w.time().unknown, truncated: w.time().truncated };

// ---- bucket every drawn marker by what could be done to its voxel -------------------------------
const diag = new Map();
const bucket = {};
const where = [];
const qr = w.TLAYER.quadRow, drawn = w.TLAYER.drawn;
for (let i = 0; i < drawn; i++) {
  const rowIdx = qr ? qr[i] : i;
  if (rowIdx == null || rowIdx < 0) continue;
  const p = w.timeRowWorld(rowIdx);
  if (!p) { bucket.noWorld = (bucket.noWorld || 0) + 1; continue; }
  const [x, y, z] = p;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), k = `${cx},${cz}`;
  let g = diag.get(k);
  if (!g) { g = w.meshDiag(cx, cz); diag.set(k, g); }
  const cls = !g.inRing ? 'outsideDetailRing'
    : !g.held ? 'payloadNotHeld'
      : !(g.suffix > 0) ? 'insideRing_noEditsForThisChunk'
        : g.installed ? 'insideRing_editsInstalled'
          : 'insideRing_editsNotInstalled';
  bucket[cls] = (bucket[cls] || 0) + 1;
  where.push({ i, x, y, z, cx, cz, cls, suffix: g.suffix, inRing: g.inRing, installed: g.installed });
}
out.markerBuckets = bucket;
out.chunksSeen = { total: diag.size, inRing: [...diag.values()].filter((g) => g.inRing).length,
  withEdits: [...diag.values()].filter((g) => g.suffix > 0).length };

// ---- which layer has geometry inside a marker's own block box -----------------------------------
const EPS = 1e-3;
function inBox(bx, by, bz, want) {
  let n = 0;
  const per = {};
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const nm = o.name || 'unnamed';
    if (want && nm !== want) return;
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
    if (h) { n += h; per[nm] = (per[nm] || 0) + h; }
  });
  return { n, per };
}

// Screen position of a world point, so a pick can be aimed at the tile the eye is on.
const screen = (x, y, z) => {
  const s = w.screenOf(x, y, z);
  return s && Number.isFinite(s.x) ? [s.x, s.y, s.ndcz] : null;
};

const samples = [];
const pickOne = (cls, n) => where.filter((m) => m.cls === cls).slice(0, n);
for (const m of [...pickOne('insideRing_editsInstalled', 3), ...pickOne('outsideDetailRing', 3)]) {
  const own = inBox(m.x, m.y, m.z);
  const below = inBox(m.x, m.y - 1, m.z);
  const px = screen(m.x + 0.5, m.y + 1.05, m.z + 0.5);
  const hits = px ? w.pickStack(Math.round(px[0]), Math.round(px[1]), 4).map((h) => ({
    from: h.drawn, block: h.block, state: h.state ?? h.shellState, lodTile: h.lodTile,
    point: h.point, quad: h.quad })) : null;
  samples.push({ at: [m.x, m.y, m.z], chunk: [m.cx, m.cz], cls: m.cls, editsInChunk: m.suffix,
    inRing: m.inRing, installed: m.installed, vertsInVoxel: own.n, byLayer: own.per,
    vertsBelow: below.n, layerBelow: below.per, colTop: w.column(m.x, m.z, 1), pickAtTile: hits });
}
out.samples = samples;

// The exact voxel the screenshot's outline sat on.
out.hoveredChunk = w.meshDiag(-3, -9);
out.hoveredColumn = w.column(-46, -135, 3);
out.pickAtHover = w.pickStack(Math.round(innerWidth / 2), Math.round(innerHeight / 2), 3)
  .map((h) => ({ from: h.drawn, block: h.block, state: h.state ?? h.shellState, lodTile: h.lodTile,
    point: h.point }));
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
