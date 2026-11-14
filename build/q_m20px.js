// One pixel, everything the page knows about it. The grid probe says WHERE the picture and the click
// disagree; this says WHY, for pixels named on the command line (`&px=640,267;853,267`).
//
// For each: the framebuffer colour with the overlay on and off (did the marker paint at all?), every claim
// the ray meets with its item, its draw-range verdict and its sprite verdict, the winning marker's shape, and
// the page's own owner answer. Without the per-item stack, "the marker should have painted there" is a theory.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const render = async () => { await raf(); await raf(); await raf(); };
const params = new URLSearchParams(location.search);
const want = (params.get('px') || '').split(';').map((s) => s.split(',').map(Number)).filter((a) => a.length === 2);
const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
const at = (X, sx, sy) => {
  const i = ((X.h - 1 - Math.round(sy * X.dpr)) * X.w + Math.round(sx * X.dpr)) * 4;
  return [X.buf[i], X.buf[i + 1], X.buf[i + 2]];
};
const dmax = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const seek = params.get('seek');
w.setTimePlay(0);
if (seek !== null) w.seekSec(+seek);
w.setTimePlay(0);
await settle(2000);
const out = { framing: location.search, playhead: { sec: w.time().sec, drawn: w.time().drawn, quads: w.time().quads },
  pixels: [] };
const on = (await render(), grab());
w.set('time', 0); await settle(500);
const off = (await render(), grab());
w.set('time', 1); await settle(500);
const back = (await render(), grab());
for (const s of want) {
  const [sx, sy] = s;
  const own = w.ownerAt(sx + 0.5, sy + 0.5);
  const box = w.timeMarkerBox(sx + 0.5, sy + 0.5);
  const hits = w.markerHits(sx + 0.5, sy + 0.5, 8);
  const p0 = at(on, sx, sy), p1 = at(off, sx, sy);
  out.pixels.push({ px: s, rgbOn: p0, rgbOff: p1, timeToggleDelta: dmax(p0, p1),
    restore: dmax(p0, at(back, sx, sy)),
    owner: own.owner, markerTook: own.markerTook, cube: own.markerCube, alpha: own.markerAlpha,
    paints: own.markerPaints, markDist: own.markerDist, front: own.markFrontDist,
    groundDist: own.markGroundDist, worldDist: own.worldDist, worldLayer: own.worldDrawn,
    worldState: own.worldState, markVoxel: own.markerVoxel, groundBlock: own.detailBlock,
    rayClaims: hits.map((h) => ({ dist: h.dist, item: h.item, inDrawRange: h.inDrawRange,
      sprite: h.sprite, alpha: h.alpha, voxel: h.voxel })),
    box: box && { item: box.item, quads: box.quads, overVoxel: box.overVoxel, name: box.name,
      repeat: box.repeat, drawn: box.drawn, aabb: box.aabb } });
}
out.time = (({ drawn, quads, culledFaces, fullyInside, markerGeoMb, grow, depthWrite, polyOffset,
  cullBackFaces, plantTwins, markerPick, markerAlpha }) => ({ drawn, quads, culledFaces, fullyInside,
  markerGeoMb, grow, depthWrite, polyOffset, cullBackFaces, plantTwins, markerPick,
  markerAlpha }))(w.time());
console.log('ONEPX ' + JSON.stringify(out));
