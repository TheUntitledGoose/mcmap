// The user's own framing and settings, reproduced: close in, "any change at all", playhead 8.35 % of the
// filter, "the block itself, tinted". For every logged change that is DRAWED within three chunks of the
// camera, ask what is actually standing there:
//   what the row names  (the block the log says was left standing)
//   what the voxel holds today (the browser's payload truth)
//   whether real terrain geometry occupies that voxel (a block was DRAWN there, not just a marker)
//   whether the replay wrote an edit into that chunk at all
// This is the question behind "I see the green 2D tile but not the voxel block": is the tile sitting on
// the block it describes, or on ground where the block never got drawn?
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await new Promise((r) => requestAnimationFrame(r)); w.tick(2); }
};
w.setTimePlay(0);
await settle(1200);
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.0835));   // their 27,656 / 331,040
await settle(4000);

const S = w.settings, st = w.state, T = w.TLAYER, tl = T.tl;
const eye = st.target ?? [0, 0, 0];
const ccx = Math.floor(eye[0] / 16), ccz = Math.floor(eye[2] / 16);

// Does a real (non-marker) mesh put a vertex inside this voxel? That is "a block was drawn here".
function terrainIn(bx, by, bz, eps = 1e-3) {
  let hits = 0; const layers = new Set();
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    const g = o.geometry, pa = g.attributes.position;
    if (!pa) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const c = g.boundingSphere.center, r = g.boundingSphere.radius;
    if (c.x + r < bx - eps || c.x - r > bx + 1 + eps) return;
    if (c.z + r < bz - eps || c.z - r > bz + 1 + eps) return;
    if (c.y + r < by - eps || c.y - r > by + 1 + eps) return;
    const p = pa.array;
    let h = 0;
    for (let v = 0, m = pa.count; v < m; v++) {
      if (p[v * 3] < bx - eps || p[v * 3] > bx + 1 + eps) continue;
      if (p[v * 3 + 1] < by - eps || p[v * 3 + 1] > by + 1 + eps) continue;
      if (p[v * 3 + 2] < bz - eps || p[v * 3 + 2] > bz + 1 + eps) continue;
      h++;
    }
    if (h) { hits += h; layers.add(o.name || (o.material && o.material.type) || 'mesh'); }
  });
  return { hits, layers: [...layers] };
}

const near = [];
let scanned = 0;
for (let i = 0; i < (T.drawn ?? 0); i++) {
  const cx = T.mCx[i], cz = T.mCz[i];
  if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > 3) continue;
  const row = T.quadRow?.[i];
  if (row == null || row < 0) continue;
  scanned++;
  const [x, y, z] = w.timeRowWorld(row);
  const logged = tl.nameOf ? tl.nameOf(row) : '';
  const was = tl.wasOf ? tl.wasOf(row) : '';
  const today = w.at(x, y, z);
  near.push({ voxel: [x, y, z], row, action: tl.action[row], logged, was, today,
    same: !!logged && logged === today, chunkEdits: w.histEditsOf(cx, cz) });
}
// Sample a spread of them for the expensive scene-geometry question.
const sample = near.slice(0, 14).map((m) => ({ ...m, terrain: terrainIn(...m.voxel) }));

const tally = { near: near.length, scanned, sameAsLogged: 0, differsFromLogged: 0, noName: 0, noPayload: 0,
  terrainDrawn: 0, terrainMissing: 0 };
for (const m of sample) {
  if (m.logged && m.logged === m.today) tally.sameAsLogged++;
  if (!m.logged) tally.noName++;
  else if (m.logged !== m.today) tally.differsFromLogged++;
  if (!m.today) tally.noPayload++;
  if (m.terrain.hits) tally.terrainDrawn++; else tally.terrainMissing++;
}
console.log(JSON.stringify({
  settings: { cls: S.timeCls, who: S.ledgerWho, look: S.timeLook, terrain: S.timeTerrain,
    tiles: S.timeTiles, decalOp: S.decalOp, decalShrink: S.decalShrink, grow: S.timeGrow, radius: S.radius },
  frame: { dist: st.dist, detailRadius: st.detailRadius, payloadRadius: st.payloadRadius,
    detailMeshes: st.detailMeshes, verts: st.verts },
  time: { drawn: T.drawn, quads: T.quads, look: T.look, why: T.lookWhy },
  split: w.timeSplit(), hist: w.histTotals(), stats: w.histStats(),
  nearChunks: 49, tally,
  sample: sample.map((m) => ({ v: m.voxel, logged: m.logged, today: m.today, same: m.same,
    edits: m.chunkEdits, terrainHits: m.terrain.hits, layers: m.terrain.layers })),
  note: w.histNote().split(String.fromCharCode(10)).join(' | '),
}, null, 1));
