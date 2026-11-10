// The complaint in person: "I see the green 2D tile of the placement but not the voxel block."
// Take the drawn markers NEAREST THE MIDDLE OF THE FRAME (that is where the eye is), and for each ask
// the four questions that decide whether a voxel can change there:
//   in the full-resolution ring?   payload held?   does this chunk have terrain edits?   is terrain
//   already standing in that block box (so the marker cube is buried and only its top face shows)?
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};
w.setTimePlay(0);
await settle(1200);
w.timeSeekRow(Math.min(w.TLAYER.quads - 1, 27655));
await settle(3000);

const st = w.state;
out.frame = { dist: st.dist, detailRadius: st.detailRadius, detailMeshes: st.detailMeshes,
  payloadRadius: st.payloadRadius, detailReachBlocks: st.detailReachBlocks, lodTiles: st.lodTiles,
  lodVerts: st.lodVerts, shellVerts: st.shellVerts, detailVerts: st.detailVerts, verts: st.verts };
out.hist = { chunks: w.hist().chunks, edits: w.hist().edits, marked: w.hist().marked,
  unknown: w.hist().unknown, truncated: w.hist().truncated, cap: w.hist().cap, limit: w.hist().limit };
out.time = { drawn: w.time().drawn, quads: w.time().quads, look: w.time().look, cls: w.time().cls };

const EPS = 1e-3;
function inBox(bx, by, bz) {
  const per = {};
  let n = 0;
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
      if (p[v * 3] < bx - EPS || p[v * 3] > bx + 1 + EPS) continue;
      if (p[v * 3 + 1] < by - EPS || p[v * 3 + 1] > by + 1 + EPS) continue;
      if (p[v * 3 + 2] < bz - EPS || p[v * 3 + 2] > bz + 1 + EPS) continue;
      h++;
    }
    if (h) { n += h; per[o.name || 'unnamed'] = (per[o.name || 'unnamed'] || 0) + h; }
  });
  return { n, per };
}

// Rank every drawn marker by screen distance from the middle of the frame.
const qr = w.TLAYER.quadRow, drawn = w.TLAYER.drawn;
const cx0 = Math.floor(w.state.target[0] / 16), cz0 = Math.floor(w.state.target[2] / 16);
const cand = [];
const editsMemo = new Map();
for (let i = 0; i < drawn; i++) {
  const row = qr ? qr[i] : i;
  const p = w.timeRowWorld(row);
  if (!p) continue;
  const [x, y, z] = p;
  const s = w.screenOf(x + 0.5, y + 0.5, z + 0.5);
  if (!Number.isFinite(s.x) || s.ndcz > 1 || s.ndcz < -1) continue;
  const dc = Math.max(Math.abs(Math.floor(x / 16) - cx0), Math.abs(Math.floor(z / 16) - cz0));
  if (dc > 20) continue;
  const d = Math.hypot(s.x - innerWidth / 2, s.y - innerHeight / 2);
  if (d > 260) continue;
  cand.push({ i, row, x, y, z, dc, d, px: s.x, py: s.y });
}
cand.sort((a, b) => a.d - b.d);
out.nearCentreCandidates = cand.length;

const rowsOut = [];
const tally = {};
for (const c of cand.slice(0, 14)) {
  const cx = Math.floor(c.x / 16), cz = Math.floor(c.z / 16);
  const g = w.meshDiag(cx, cz);
  if (!editsMemo.has(`${cx},${cz}`)) { const e = w.histEditsOf(cx, cz); editsMemo.set(`${cx},${cz}`, e && e.edits ? e.edits.length >> 1 : 0); }
  const edits = editsMemo.get(`${cx},${cz}`);
  const col = w.column(c.x, c.z, 1);
  const top = col.column ? (col.top && col.top[0] ? col.top[0].y : null) : null;
  const box = inBox(c.x, c.y, c.z);
  const below = inBox(c.x, c.y - 1, c.z);
  const cls = !g.inRing ? 'outsideRing'
    : !(edits > 0) ? 'inRing_chunkHasNoEdits'
      : Object.keys(box.per).some((k) => k.startsWith('detail')) ? 'inRing_terrainStandsInThatBox'
        : 'inRing_boxEmpty';
  tally[cls] = (tally[cls] || 0) + 1;
  rowsOut.push({ at: [c.x, c.y, c.z], px: [Math.round(c.px), Math.round(c.py)], chunk: [cx, cz], dc: c.dc,
    inRing: g.inRing, installed: !!g.installed, edits, colTopY: top, markerY: c.y,
    buriedByPayload: top != null && top >= c.y + 1, vertsInBox: box.n, layers: box.per,
    vertsBelow: below.n, belowLayers: below.per, drawnChangeHere: w.timeDrawnAt(c.x, c.y, c.z) });
}
out.nearCentre = rowsOut;
out.tally = tally;

// Farther out on the same frame: how many drawn changes stand on ground the replay cannot re-cut.
let outside = 0, inside = 0, far = 0;
for (let i = 0; i < drawn; i++) {
  const row = qr ? qr[i] : i;
  const p = w.timeRowWorld(row);
  if (!p) continue;
  const dc = Math.max(Math.abs(Math.floor(p[0] / 16) - cx0), Math.abs(Math.floor(p[2] / 16) - cz0));
  if (dc <= st.detailRadius + 1) inside++; else outside++;
  if (dc > 20) far++;
}
out.drawnSplit = { insideRing: inside, outsideRing: outside, beyond20Chunks: far, of: drawn };
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
