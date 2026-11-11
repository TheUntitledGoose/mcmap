// Does a marker that sits EXACTLY on its voxel (the shipped `?timegrow=0`) actually paint, or does it lose a
// depth fight with the terrain face it is coplanar with? One page load, one camera.
//
// The two grabs differ in exactly one thing: the marker layer's DRAW RANGE. `timeSeekRow(0)` leaves one
// marker standing, the end of the filter draws all of them, and the voxel replay is switched off by the URL
// (`timeterrain=0`) so no block moves between the grabs. Then every aimed pixel either changes colour - the
// marker's wash is what reached the framebuffer - or it does not, which is a coplanar fight the marker lost.
//
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timeterrain=0&timecls=2&timeat=71042477&caves=1&bodies=0&res=1&noautores" \
//     --wait 14000 --eval-file build/q_flushab.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';
w.setTimePlay(0);
w.timeSeekRow(w.time().quads - 1);          // every claim of the filter is drawn
await settle(2500);

const grab = () => w.grab();
const pxAt = (f, sx, sy) => {
  const i = ((Math.round(innerHeight - sy - 0.5) * f.dpr) * f.w + Math.round((sx + 0.5) * f.dpr)) * 4;
  return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
};

const camA = w.camPos();
const on = grab();
w.timeSeekRow(0);                           // one marker left; nothing else in the scene moves
await settle(900);
const off = grab();
const camB = w.camPos();
w.timeSeekRow(w.time().quads - 1);
await settle(600);

// Aim at a lattice of the frame and keep the points where the marker layer itself answers the ray.
const aims = [];
for (let sy = 90; sy < innerHeight - 90 && aims.length < 60; sy += 46) {
  for (let sx = 90; sx < innerWidth - 90 && aims.length < 60; sx += 46) {
    const hit = w.timeHitAt(sx, sy);
    if (hit) aims.push({ sx, sy, dist: +hit.dist.toFixed(2), item: hit.item, at: hit.voxel, act: hit.action });
  }
}
const painted = [];
for (const a of aims) {
  const cOn = pxAt(on, a.sx, a.sy), cOff = pxAt(off, a.sx, a.sy);
  const d = Math.max(...cOn.map((v, i) => Math.abs(v - cOff[i])));
  painted.push({ ...a, on: cOn, off: cOff, delta: d, paints: d > 6 });
}
let frame = 0, n = 0;
for (let i = 0; i < on.buf.length; i += 16) {
  n++;
  if (Math.abs(on.buf[i] - off.buf[i]) > 6 || Math.abs(on.buf[i + 1] - off.buf[i + 1]) > 6
    || Math.abs(on.buf[i + 2] - off.buf[i + 2]) > 6) frame++;
}
const t = w.time();
console.log(JSON.stringify({
  camStable: camA.every((v, i) => Math.abs(v - camB[i]) < 0.01),
  bufOn: [on.w, on.h, on.dpr], bufOff: [off.w, off.h, off.dpr],
  aims: aims.length,
  painted: painted.filter((p) => p.paints).length,
  notPainted: painted.filter((p) => !p.paints),
  frameChangedPct: +(100 * frame / n).toFixed(1),
  markers: t.quads, markerDrawn: t.drawn, grow: t.grow, polyOffset: t.polyOffset,
  look: t.look, err: t.err || '',
}, null, 1));
