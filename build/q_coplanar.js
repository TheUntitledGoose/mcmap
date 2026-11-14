// A change marker that sits exactly on a block that still stands is coplanar with that block's own face.
// "Does it paint there?" is not answerable by a raycast - it is a depth-buffer contest settled by
// polygonOffset - so measure it: find pixels the page says belong to a marker at its own voxel, then read
// the same pixel with the overlay on and off, and again with a small outward shell (?timegrow).
//
// If on/off changes nothing at those pixels, the flush default (timeGrow=0) hides the annotation on the
// very blocks it describes, and the coplanar tie must be won another way - not by a pick rule that claims
// the pixel for a marker the framebuffer never painted.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const render = async () => { await raf(); await raf(); await raf(); };
const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
const pxAt = (X, sx, sy) => {
  const i = ((X.h - 1 - Math.round(sy * X.dpr)) * X.w + Math.round(sx * X.dpr)) * 4;
  return [X.buf[i], X.buf[i + 1], X.buf[i + 2]];
};
const dmax = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const params = new URLSearchParams(location.search);
const growAlt = Number(params.get('growalt') || 0.06);

for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const seek = params.get('seek');
w.setTimePlay(0);
if (seek !== null) w.seekSec(+seek);
w.setTimePlay(0);
await settle(2000);

// find pixels the page itself calls marker-owned at the marker's own voxel
const out = { framing: location.search, playhead: { sec: w.time().sec, drawn: w.time().drawn, quads: w.time().quads },
  time0: (({ quads, drawn, culledFaces, fullyInside, markerGeoMb, grow, cullBackFaces, plantTwins,
    depthWrite, polyOffset }) => ({ quads, drawn, culledFaces, fullyInside, markerGeoMb, grow,
    cullBackFaces, plantTwins, depthWrite, polyOffset }))(w.time()),
  candidates: [], coplanar: [], other: [] };
for (let j = 1; j <= 5; j++) {
  for (let k = 1; k <= 5; k++) {
    if (out.candidates.length >= 10) break;
    const sx = Math.round((innerWidth * k) / 6), sy = Math.round((innerHeight * j) / 6);
    const own = w.ownerAt(sx + 0.5, sy + 0.5);
    if (own.owner !== 'marker' || own.markerDist == null) continue;
    const cop = own.markFrontDist != null && Math.abs(own.markerDist - own.markFrontDist) <= 0.02;
    out.candidates.push({ px: [sx, sy], owner: own.owner, cube: own.markerCube, alpha: own.markerAlpha,
      paints: own.markerPaints, took: own.markerTook, coplanar: cop,
      dists: { mark: own.markerDist, front: own.markFrontDist, ground: own.markGroundDist, world: own.worldDist },
      world: own.worldState, markVoxel: own.markerVoxel, groundBlock: own.detailBlock });
    (cop ? out.coplanar : out.other).push([sx, sy]);
  }
}

// what the frame actually shows at those pixels, overlay on vs off
const on = (await render(), grab());
w.set('time', 0); await settle(400);
const off = (await render(), grab());
w.set('time', 1); await settle(400);
out.atPixels = out.candidates.map((c) => ({ px: c.px, coplanar: c.coplanar, cube: c.cube,
  on: pxAt(on, c.px[0], c.px[1]), off: pxAt(off, c.px[0], c.px[1]), delta: dmax(pxAt(on, c.px[0], c.px[1]), pxAt(off, c.px[0], c.px[1])) }));

// the same pixels with a small outward shell, which should win any coplanar contest outright
const g0 = w.time().grow;
w.set('timegrow', growAlt);
for (let i = 0; i < 40 && w.time().grow === g0; i++) await settle(250);
await settle(1500);
const altOn = (await render(), grab());
w.set('time', 0); await settle(400);
const altOff = (await render(), grab());
w.set('time', 1); await settle(400);
out.growAlt = { want: growAlt, got: w.time().grow, quads: w.time().quads, markerGeoMb: w.time().markerGeoMb,
  pixels: out.candidates.map((c) => ({ px: c.px, coplanar: c.coplanar,
    delta: dmax(pxAt(altOn, c.px[0], c.px[1]), pxAt(altOff, c.px[0], c.px[1])) })) };

out.pixelsChanged = { flush: 0, shell: 0 };
for (let i = 0; i < on.buf.length; i += 4) {
  if (dmax([on.buf[i], on.buf[i + 1], on.buf[i + 2]], [off.buf[i], off.buf[i + 1], off.buf[i + 2]]) > 12) out.pixelsChanged.flush++;
  if (dmax([altOn.buf[i], altOn.buf[i + 1], altOn.buf[i + 2]], [altOff.buf[i], altOff.buf[i + 1], altOff.buf[i + 2]]) > 12) out.pixelsChanged.shell++;
}
console.log('COPLANAR ' + JSON.stringify(out));
