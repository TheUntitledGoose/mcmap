// The wall of placed blocks at x -48..-33, z -128..-113: does the marker layer draw the inside of it,
// and does anything it draws leave its voxel? (The `await` is what makes browser-probe.mjs wrap this in an
// async IIFE, so `return` is legal here.)
const w = window.__world;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const t = w.time();
return {
  look: t.look, want: t.lookWant, lookWhy: t.lookWhy,
  items: t.quads, verts: t.verts, drawn: t.drawn, playheadSec: t.sec,
  culledFaces: t.culledFaces, fullyInside: t.fullyInside, faceCull: t.faceCull,
  // one marker per voxel now: `stacked` counts the drawn markers that superseded an earlier claim of the
  // same voxel, `maxStack` how many claims that deepest voxel holds, `dedupedClaims` the claims not drawn
  stacked: t.stacked, maxStack: t.maxStack, dedupedClaims: t.dedupedClaims,
  grow: t.grow, stackRamp: t.stackRamp,
  depthTest: t.depthTest, polyOffset: t.polyOffset,
  markerGeoMb: t.markerGeoMb, err: t.err || '',
};
