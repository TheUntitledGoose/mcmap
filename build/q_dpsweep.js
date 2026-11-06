// Where does the pixel rule actually bite? The row says a distance; this is that distance, measured.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);
const out = [];
for (const d of [200, 300, 500, 650, 700, 760, 900, 1200, 2000, 6000]) {
  w.set('dist', d);
  await sleep(2500);
  const s = w.state;
  out.push({ dist: Math.round(s.dist), ring: s.detailRadius, ceiling: s.detailCeiling,
    meshes: s.detailMeshes, reach: s.detailReachBlocks, verts: +(s.verts / 1e6).toFixed(1),
    fps: +s.fps.toFixed(0) });
}
return JSON.stringify(out, null, 1);
