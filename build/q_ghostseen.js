// One voxel question, two consumers. The people layer picks its depth policy from `bodyWall`, and so does
// the click - so the frame and the answer must agree. For every standing body at the playhead this asks:
// what the voxels answered, whether the body paints the pixel it sits at, and whether the page's own click
// agrees with that. A body that answers a click it never painted is the bug this replaces.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const render = async () => { await raf(); await raf(); await raf(); };
const q = new URLSearchParams(location.search);
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
w.setTimePlay(0);
if (q.get('gsec')) w.seekSec(+q.get('gsec'));
await settle(900);
w.setTimePlay(0);
await settle(500);
const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
// one framebuffer pixel, in the page's own screen coordinates (readPixels rows start at the BOTTOM)
const pxAt = (X, sx, sy) => {
  const i = ((X.h - 1 - Math.round(sy * X.dpr)) * X.w + Math.round(sx * X.dpr)) * 4;
  return [X.buf[i], X.buf[i + 1], X.buf[i + 2]];
};
const boxDiff = (A, B, sx, sy, r) => {
  let n = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const a = pxAt(A, sx + dx, sy + dy), b = pxAt(B, sx + dx, sy + dy);
    if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > 6) n++;
  }
  return n;
};
const g0 = w.ghosts();
const cp = w.camPos();
const rows = [];
for (const b of (g0.bodies ?? []).filter((x) => !x.absent)) {
  const p = w.project(b.x + 0.5, b.y + 1.0, b.z + 0.5);
  const sx = Math.round(p[0]), sy = Math.round(p[1]);
  if (p[2] > 1) continue;                                   // behind this eye
  const own = w.ownerAt(sx, sy);
  const on = grab();
  w.set('bodies', 0); await render();
  const off = grab();
  w.set('bodies', 1); await render();
  const back = grab();
  const centreChanged = pxAt(on, sx, sy).join() !== pxAt(off, sx, sy).join();
  rows.push({
    who: g0.presence?.players?.find((pp) => pp.player === b.player)?.name ?? b.player,
    at: [sx, sy], seen: b.seen, seat: b.seat, down: b.down,
    eye: +Math.hypot(cp[0] - b.x, cp[1] - b.y, cp[2] - b.z).toFixed(1),
    owner: own?.owner, rule: own?.rule ?? null, bodyDist: own?.bodyDist ?? null,
    centreOn: pxAt(on, sx, sy), centreOff: pxAt(off, sx, sy), centreChanged,
    boxPainted: boxDiff(on, off, sx, sy, 9),
    agree: (own?.owner === 'body') === centreChanged,
    stable: pxAt(on, sx, sy).join() === pxAt(back, sx, sy).join(),
  });
}
console.log('SEEN ' + JSON.stringify({
  gsec: w.time().sec, standing: g0.standing, seenCounts: g0.seen, seenDrawn: g0.seenDrawn,
  seenRule: g0.seenRule, disagreements: rows.filter((r) => !r.agree).length,
  unpainted: rows.filter((r) => !r.centreChanged).length, unstable: rows.filter((r) => !r.stable).length,
  rows, note: w.ghostNote(),
}));
