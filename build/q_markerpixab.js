// Does the marker layer sort ITSELF? The layer tests the world's depth but (by default) does not write its
// own, because a marker that writes depth can seal a person standing in the voxel it annotates. The cost of
// that choice is a second question: a FAR marker can paint over a NEAR one, because nothing in the layer
// records depth for the next marker to test against. This measures how much of the picture that is, by
// flipping the layer's own depth-write inside one page and counting what moves.
//
// Same camera, same playhead, same buffer: only the material flag changes, so every changed pixel is the
// sort order. `&rows=N` optionally cuts the layer short with seekRow for a smaller framing.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const out = {};
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const q = new URLSearchParams(location.search);
w.setTimePlay(0);
if (q.get('seek')) {
  const s = q.get('seek');
  const sec = /^\d+$/.test(s) ? +s : Math.round((Date.parse(s) - w.time().base * 1000) / 1000);
  w.seekSec(sec);
}
if (q.get('rows')) w.seekRow(+q.get('rows'));
await settle(800);
w.setTimePlay(0);
await settle(400);
out.playhead = w.time().sec;
out.drawn = w.time().drawn;

const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
const render = async () => { await raf(); await raf(); await raf(); };

// A control pair FIRST: a layer still streaming tiles moves the frame on its own, and an A/B against a
// moving picture measures nothing. Settle until two identical grabs agree, then switch.
let A = null, base = null;
for (let tryNo = 0; tryNo < 6; tryNo++) {
  A = (out.off = w.markDepth(0), await render(), grab());
  base = (await render(), grab());
  if (diff(A, base).changed < 400) break;
  await settle(1200);
}
out.control = diff(A, base);

function diff(p, r, sample = 0) {
  let changed = 0, maxd = 0; const at = [];
  const n = Math.min(p.buf.length, r.buf.length);
  const W = p.w, H = p.h;
  for (let i = 0; i < n; i += 4) {
    const d = Math.max(Math.abs(p.buf[i] - r.buf[i]), Math.abs(p.buf[i + 1] - r.buf[i + 1]),
      Math.abs(p.buf[i + 2] - r.buf[i + 2]));
    if (d > 6) {
      changed++; if (d > maxd) maxd = d;
      if (sample && at.length < sample) {
        const px = (i / 4) % W, row = Math.floor((i / 4) / W);
        // readPixels rows start at the BOTTOM of the frame, and the buffer is in device pixels: the page's
        // ray wants screen pixels, so divide by the draw ratio as well as flipping y.
        at.push([Math.round(px / p.dpr), Math.round((H - 1 - row) / p.dpr)]);
      }
    }
  }
  return { changed, maxd, frame: n / 4, at };
}
const B = (out.on = w.markDepth(1), await render(), grab());
out.depthOnChanged = diff(A, B, 40);
const C2 = (w.markDepth(0), await render(), grab());
out.controlBack = diff(A, C2);

// What kind of overlap is moving? Two claims of ONE voxel sit at one distance, so the picture must decide
// them by claim order (and a layer that writes depth makes them fight for the same pixels). Two claims of
// DIFFERENT voxels sit at different distances, so the nearer one owns the pixel - and with no depth-write
// the farther one paints over it. Different answers, one switch.
const kind = { dupClaim: 0, nearFar: 0, oneItem: 0, none: 0 }; const eg = [];
for (const [px, py] of out.depthOnChanged.at) {
  const all = w.markerHits(px, py, 12);
  if (!all.length) { kind.none++; continue; }
  // One cube gives the ray an entry AND an exit face, so raw hits over-count a single marker. Compare items,
  // not triangles: an item is one claim.
  const byItem = new Map();
  for (const h of all) if (!byItem.has(h.item)) byItem.set(h.item, h);
  const items = [...byItem.values()].sort((a, b) => a.dist - b.dist);
  if (items.length === 1) { kind.oneItem++; continue; }
  const a = items[0], b = items[1];
  const sameVoxel = a.voxel && b.voxel && a.voxel.join() === b.voxel.join();
  if (sameVoxel) kind.dupClaim++; else kind.nearFar++;
  if (eg.length < 4) eg.push({ px, py, gap: +(b.dist - a.dist).toFixed(3), sameVoxel,
    items: items.slice(0, 3).map((h) => ({ item: h.item, sec: h.sec, voxel: h.voxel, dist: h.dist })) });
}
out.overlap = { kind, eg };
out.time = (({ quads, drawn, look, culledFaces, fullyInside, faceCull, dedupedClaims, maxStack,
  markerGeoMb, depthTest, polyOffset }) => ({ quads, drawn, look, culledFaces, fullyInside, faceCull,
  dedupedClaims, maxStack, markerGeoMb, depthTest, polyOffset }))(w.time());
console.log('PIXAB ' + JSON.stringify(out));
