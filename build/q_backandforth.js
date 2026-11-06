// build/q_backandforth.js - pan away and back, then say what the detail layer is holding.
// The user's report: after panning away and returning, the near terrain is drawn as stretched,
// sheared quads. Whatever this returns, the screenshot that follows is the evidence.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [x, y, z] = w.state.target;
for (let i = 1; i <= 4; i++) { w.go(x + 120 * i, y, z + 90 * i); await sleep(400); }
await sleep(5000);
w.go(x, y, z);
await sleep(9000);
const s = w.state;
return {
  target: s.target, verts: s.verts, tris: s.tris, drawn: s.drawn,
  chunks: s.chunks, detailMeshes: s.detailMeshes, detailVerts: s.detailVerts,
  demoted: s.demoted, meshReused: s.meshReused, meshCacheDropped: s.meshCacheDropped,
  parkThenBuild: s.parkThenBuild, meshBytesGhost: s.meshBytesGhost, meshCachedChunks: s.meshCachedChunks,
  meshCacheMB: s.meshCacheMB, ringStuck: s.ringStuck, detailRadius: s.detailRadius,
  meshIndex: s.meshIndex, soup: s.soup, meshKey: s.meshKey, meshCacheMb: s.meshCacheMb,
  patchVerts: s.shellVerts, patches: s.shellPatches, lodTiles: s.lodTiles,
};
