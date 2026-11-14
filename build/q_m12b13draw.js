// Two complaints, one framing, answered in pixels rather than in raycasts.
//
//   1. "the draw order is fucked up": flip the marker layer's own depth-write off (log order) and count the
//      pixels that move. Those are pixels the layer decided by LOG ORDER rather than by depth.
//   2. "the faces in the back are again inverted": flip the layer back to a two-sided material and count
//      what moves. Those are pixels an INSIDE face was winning.
//   3. the people: at each standing body's own pixel, does the frame change when bodies switch off, and does
//      the page's own click answer agree? A pick that says person while the frame says rock is the bug.
//
// A control pair comes FIRST: a picture that moves on its own measures nothing.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const render = async () => { await raf(); await raf(); await raf(); };
const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
function diff(p, r, sample = 0) {
  let changed = 0, maxd = 0; const at = [];
  const n = Math.min(p.buf.length, r.buf.length), W = p.w, H = p.h;
  for (let i = 0; i < n; i += 4) {
    const d = Math.max(Math.abs(p.buf[i] - r.buf[i]), Math.abs(p.buf[i + 1] - r.buf[i + 1]),
      Math.abs(p.buf[i + 2] - r.buf[i + 2]));
    if (d > 6) { changed++; if (d > maxd) maxd = d;
      if (sample && at.length < sample) {
        const px = (i / 4) % W, row = Math.floor((i / 4) / W);
        at.push([Math.round(px / p.dpr), Math.round((H - 1 - row) / p.dpr)]);
      } }
  }
  return { changed, maxd, frame: n / 4, at };
}
const out = {};
const q = new URLSearchParams(location.search);
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
w.setTimePlay(0);
if (q.get('seek')) {
  const s = q.get('seek');
  const sec = /^\d+$/.test(s) ? +s : Math.round((Date.parse(s) - w.time().base * 1000) / 1000);
  w.seekSec(sec);
}
if (q.get('gsec')) w.seekSec(+q.get('gsec'));
await settle(900);
w.setTimePlay(0);
await settle(400);

let A = null, base = null;
for (let tryNo = 0; tryNo < 6; tryNo++) {
  A = await render(), base = await render(), base = grab(), A = grab();
  if (diff(A, base).changed < 400) break;
  await settle(1200);
}
out.control = diff(A, base);

// (1) the layer's own sort
const B = (w.markDepth(0), await render(), grab());
out.unsorted = diff(A, B, 8);
w.markDepth(1); await render();
out.sortBack = diff(A, grab());                     // back to the shipped state must cost nothing

// (2) inside faces
const C = (w.markSide(0), await render(), grab());
out.twoSided = diff(A, C, 8);
w.markSide(1); await render();
out.sideBack = diff(A, grab());

// (3) the people, at their own pixel
const g = w.ghosts();
out.seen = { standing: g.standing, counts: g.seen ?? {}, drawn: g.seenDrawn, rule: g.seenRule };
const bodies = [];
for (const b of (g.bodies ?? []).filter((x) => !x.absent)) {
  const p = w.project(b.x + 0.5, b.y + 1.0, b.z + 0.5);
  if (p[2] > 1) continue;                                  // behind the camera
  const px = Math.round(p[0]), py = Math.round(p[1]);
  const own = w.ownerAt(px, py);
  const on = grab();
  w.set('bodies', 0); await render();
  const off = grab();
  w.set('bodies', 1); await render();
  const back = grab();
  const box = diff(on, off, 0);
  // the aimed pixel itself: a body that "owns" a pixel it never paints is the old bug
  // one pixel, read out of both grabs (the buffer starts at the BOTTOM row, and is in device pixels)
  const onePx = (X, Y, dpr, W, H) => {
    const i = ((H - 1 - Math.round(Y * dpr)) * W + Math.round(X * dpr)) * 4;
    return [X.buf[i], X.buf[i + 1], X.buf[i + 2]];
  };
  const centreChanged = onePx(on, px, py, on.dpr, on.w, on.h).join()
    !== onePx(off, px, py, off.dpr, off.w, off.h).join();
  bodies.push({ who: g.presence?.players?.find((pp) => pp.player === b.player)?.name ?? b.player,
    at: [px, py], seen: b.seen, seat: b.seat, down: b.down,
    owner: own?.owner, hitSeen: own?.seen ?? own?.bodySeen ?? null, bodyDist: own?.bodyDist ?? null,
    centreChanged, centreOn: onePx(on, px, py, on.dpr, on.w, on.h), centreOff: onePx(off, px, py, off.dpr, off.w, off.h),
    boxChanged: box.changed, stable: diff(back, on, 0).changed === 0 });
}
out.bodies = bodies;
out.time = (({ quads, drawn, look, culledFaces, fullyInside, dedupedClaims, maxStack, markerGeoMb,
  depthTest, depthWrite, cullBackFaces, plantTwins }) => ({ quads, drawn, look, culledFaces, fullyInside,
  dedupedClaims, maxStack, markerGeoMb, depthTest, depthWrite, cullBackFaces, plantTwins }))(w.time());
out.note = w.timeNote();
out.people = w.ghostNote();
console.log('DRAWFIX ' + JSON.stringify(out));
