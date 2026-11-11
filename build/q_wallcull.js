// The wall of placed blocks at x -48..-33, z -128..-113: does the marker layer draw the inside of it?
// (The `await` is what makes browser-probe.mjs wrap this in an async IIFE, so `return` is legal here.)
const w = window.__world;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const t = w.time();
return {
  look: t.look, want: t.lookWant, lookWhy: t.lookWhy,
  items: t.quads, verts: t.verts, drawn: t.drawn, playheadSec: t.sec,
  culledFaces: t.culledFaces, fullyInside: t.fullyInside, faceCull: t.faceCull,
  stacked: t.stacked, maxStack: t.maxStack, markerGeoMb: t.markerGeoMb,
  err: t.err || '',
};
