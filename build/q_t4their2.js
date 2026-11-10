const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
const V3 = w.camera.position.constructor;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);

// the user's entry point: any change, everybody, paused, a playhead partway through the log
w.settings.timeTouched = 1; w.settings.timeCls = 0; w.settings.timeWho = 0;
w.settings.timePlay = 0; w.settings.timeTerrain = 1;
w.timeRebuild();
for (let i = 0; i < 20 && w.TLAYER.quads; i++) { await settle(300); if (w.TLAYER.built) break; }
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));
await settle(8000);

const st = w.state;
const cp = w.camPos();
const camV = new V3(cp[0], cp[1], cp[2]);
const tgt = new V3(st.eye[0], st.eye[1], st.eye[2]);
const T = w.TLAYER;
const tl = T.tl;
const g = T.mesh && T.mesh.geometry;
const P = g && g.attributes.position.array;
const IX = g && g.index && g.index.array;
const E = T.markerEnd;
const drawn = T.drawn;

// bounding-sphere-pruned terrain scan: which layers paint geometry inside this voxel?
const boxes = [];
w.scene.traverse((o) => {
  if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
  if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
  const bs = o.geometry.boundingSphere;
  if (!bs) return;
  o.updateWorldMatrix?.(false, false);
  const M = o.matrixWorld.elements;
  const c = new V3(bs.center.x, bs.center.y, bs.center.z).applyMatrix4(o.matrixWorld);
  const scale = Math.hypot(M[0], M[1], M[2]);
  boxes.push({ name: o.name || '?', c, r: bs.radius * scale, geo: o.geometry, M: o.matrixWorld });
});
const p = new V3();
const terrainAt = (x, y, z) => {
  const hits = {};
  for (const b of boxes) {
    if (Math.abs(b.c.x - (x + 0.5)) > b.r + 0.7 || Math.abs(b.c.y - (y + 0.5)) > b.r + 0.7 ||
        Math.abs(b.c.z - (z + 0.5)) > b.r + 0.7) continue;
    const a = b.geo.attributes.position.array;
    let n = 0;
    for (let i = 0; i < a.length; i += 3) {
      p.set(a[i], a[i + 1], a[i + 2]).applyMatrix4(b.M);
      if (p.x > x && p.x < x + 1 && p.y > y && p.y < y + 1 && p.z > z && p.z < z + 1) n++;
    }
    if (n) hits[b.name] = (hits[b.name] || 0) + n;
  }
  return hits;
};

const rows = [];
for (let i = 0; i < drawn; i++) {
  const end = E[i], start = i ? E[i - 1] : 0;
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
  for (let k = start; k < end; k++) {
    const o = IX[k] * 3, x = P[o], y = P[o + 1], z = P[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = Math.round((x0 + x1) / 2 - 0.5), cy = Math.round((y0 + y1) / 2 - 0.5), cz = Math.round((z0 + z1) / 2 - 0.5);
  const c = new V3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  if (c.distanceTo(camV) > 500) continue;
  const q = c.clone().project(w.camera);
  if (q.z > 1 || q.z < -1 || Math.abs(q.x) > 0.30 || Math.abs(q.y) > 0.30) continue;
  const row = T.quadRow[i];
  const mk = w.histEditsOf(T.mCx[i], T.mCz[i]);
  const arr = mk && mk.edits;
  const n = arr ? arr.length / 2 : -1;
  const packed = (cx & 15) | ((cz & 15) << 4) | ((cy + 4096) << 8);
  let editHere = 0, editTo = null;
  if (arr) for (let k = 0; k < arr.length; k += 2) if (arr[k] === packed) { editHere = 1; editTo = arr[k + 1]; break; }
  const ringD = Math.max(Math.abs(T.mCx[i] - (tgt.x >> 4)), Math.abs(T.mCz[i] - (tgt.z >> 4)));
  rows.push({
    v: [cx, cy, cz],
    chunk: [T.mCx[i], T.mCz[i]],
    ringDist: ringD, inRing: ringD <= w.settings.radius ? 1 : 0,
    ndc: [+q.x.toFixed(2), +q.y.toFixed(2)],
    fromCentre: +c.distanceTo(tgt).toFixed(0),
    logged: tl.nameOf(row) || '-',
    was: tl.wasOf ? (tl.wasOf(row) || '-') : '-',
    cls: tl.action[row],
    today: w.at(cx, cy, cz),
    chunkEdits: n,
    editHere, editTo,
  });
}
rows.sort((a, b) => (Math.abs(a.ndc[0]) + Math.abs(a.ndc[1])) - (Math.abs(b.ndc[0]) + Math.abs(b.ndc[1])));
const near = rows.slice(0, 5);
for (const r of near) r.terrain = terrainAt(r.v[0], r.v[1], r.v[2]);

const tally = {}, offs = { in: 0, out: 0 };
for (const r of rows) {
  tally[r.cls] = (tally[r.cls] || 0) + 1;
  offs[r.inRing ? 'in' : 'out']++;
}
console.log(JSON.stringify({
  camPos: cp, orbitTarget: st.eye, dist: st.dist, radius: st.radius ?? w.settings.radius,
  drawn, quads: T.quads, look: T.look, grow: w.settings.timeGrow, detailR: w.settings.radius,
  centreMarkers: rows.length, byChunk: offs, clsTally: tally,
  split: w.timeSplit(),
  near: near.map((r) => ({ v: r.v, chunk: r.chunk, ringDist: r.ringDist, inRing: r.inRing, ndc: r.ndc,
    fromCentre: r.fromCentre, logged: r.logged, was: r.was, cls: r.cls, today: r.today,
    same: r.logged === r.today, chunkEdits: r.chunkEdits, editHere: r.editHere, editTo: r.editTo, terrain: r.terrain })),
  hist: w.histTotals(),
  err: T.err || (w.ledger && w.ledger().err) || '',
}, null, 1));
