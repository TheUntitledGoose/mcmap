// build/q_indexhealth.js - walk every indexed geometry in the scene and check the index against the
// vertex count. A triangle whose index reaches past its attribute array does not throw: it reads
// whatever memory is there, which draws as stretched, sheared, rainbow-striped quads.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scan = () => {
  const bad = [];
  const byKind = {};
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const kind = `${o.name || 'mesh'}@${(o.parent && o.parent.name) || 'root'}`;
    const rec = byKind[kind] || (byKind[kind] = { n: 0, verts: 0, tris: 0, idx32: 0, idx16: 0, over: 0, emptyIdx: 0, stripped: 0 });
    rec.n++; rec.verts += pos.count;
    if (!g.index) {
      rec.tris += pos.count / 3;
      // 4 corners a quad with no index buffer is the park bug: the array is indexed-layout data, and
      // drawn as a strip it shears every quad across its neighbours.
      if (/^detail/.test(o.name) && pos.count % 6 !== 0) rec.stripped++;
      return;
    }
    const ix = g.index.array;
    rec.tris += g.index.count / 3;
    rec[ix.BYTES_PER_ELEMENT === 4 ? 'idx32' : 'idx16']++;
    if (g.index.count === 0) rec.emptyIdx++;
    let mx = -1;
    for (let i = 0; i < ix.length; i++) if (ix[i] > mx) mx = ix[i];
    if (mx >= pos.count) {
      rec.over++;
      if (bad.length < 8) bad.push({ kind, verts: pos.count, idxCount: g.index.count, idxMax: mx,
        width: ix.BYTES_PER_ELEMENT, uvCount: g.attributes.uv?.count ?? -1,
        colorCount: g.attributes.color?.count ?? -1, uvType: g.attributes.uv?.array?.constructor?.name,
        posType: pos.array.constructor.name });
    }
    if (g.attributes.uv && g.attributes.uv.count !== pos.count) rec.emptyIdx++;
  });
  return { byKind, bad };
};
const before = scan();
const [x, y, z] = w.state.target;
for (let i = 1; i <= 4; i++) { w.go(x + 90 * i, y, z + 70 * i); await sleep(400); }
await sleep(5000);
w.go(x, y, z);
await sleep(9000);
const after = scan();
const s = w.state;
return {
  beforeBad: before.bad, afterBad: after.bad,
  beforeOver: Object.entries(before.byKind).filter(([, v]) => v.over).map(([k, v]) => [k, v.over]),
  afterOver: Object.entries(after.byKind).filter(([, v]) => v.over).map(([k, v]) => [k, v.over]),
  afterKinds: after.byKind,
  mismatchedAttrs: Object.values(after.byKind).reduce((a, v) => a + v.emptyIdx, 0),
  verts: s.verts, detailMeshes: s.detailMeshes, meshBytesGhost: s.meshBytesGhost,
  meshReused: s.meshReused, parkThenBuild: s.parkThenBuild, meshIndex: s.meshIndex,
  parkedIndex: s.parkedIndex, installedIndex: s.installedIndex, cachedInstalls: s.cachedInstalls,
  parkIndexLost: s.parkIndexLost,
  strippedDetail: Object.values(after.byKind).reduce((a2, v) => a2 + (v.stripped || 0), 0),
};
