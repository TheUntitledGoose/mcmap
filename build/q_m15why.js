// One body, one framing, everything the page knows about that pixel.
// build/q_m15why.js — some framings say the body owns the pixel while the frame says nothing
// paints there. Dump every terrain hit along the ray, the body layer's own counters on and off,
// the marker and body answers for that pixel, and what a bodies on/off does to each pixel of the
// body's projected box — with walls obeyed and with depthTest switched off (?bodythrough=1), which
// separates "not drawn at all" from "drawn and hidden by a nearer depth value".
const w = window.__world;
const settle = async (ms) => {
  const t0 = performance.now();
  await new Promise((done) => requestAnimationFrame(() => done()));
  while (performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 60));
};
const P = new URLSearchParams(location.search);
const gsec = +P.get('gsec');
const gat = (P.get('gat') || '').split(',').map(Number);
w.setTimePlay(0);
w.ghostApply(gsec);
await settle(800);
const G = w.ghosts();
const b = (gat.length === 3 && isFinite(gat[0])
  ? G.bodies.find((q) => !q.absent && q.x === gat[0] && q.y === gat[1] && q.z === gat[2])
  : G.bodies.find((q) => !q.absent)) || G.bodies.find((q) => !q.absent);
const gx = b.x + 0.5, gy = b.y + 1.0, gz = b.z + 0.5;
w.go(gx, gy, gz);
w.orbit(Math.atan2(0, -9), -0.15, 10);
w.sync();
await settle(3000);
const out = { body: [b.x, b.y, b.z], player: b.player, seat: b.seat, down: b.down, cam: w.camPos() };
const c = w.project(b.x, b.y + 0.9, b.z);
const top = w.project(b.x, b.y + 1.8, b.z), bot = w.project(b.x, b.y, b.z);
out.centre = [Math.round(c[0]), Math.round(c[1])];
out.box = [Math.round(c[0] - 34), Math.round(top[1]), Math.round(c[0] + 34), Math.round(bot[1])];
if (!isFinite(out.centre[0])) {
  console.log(JSON.stringify({ bad: 'projection is not a number', cam: w.camPos(), body: b,
    proj: [c, top, bot], st: { eye: w.state.eye, target: w.state.target } }));
} else {
  const cx = out.centre[0], cy = out.centre[1];
  w.set('bodies', 1); await settle(900);
  out.on = { verts: w.ghosts().verts, drawn: w.ghosts().drawn, routes: w.ghosts().routes };
  out.stack = w.pickStack(cx, cy, 6).map((h) => ({
    drawn: h.drawn, dist: h.dist, block: h.block && h.block[0], quad: h.quad, op: h.op, cls: h.cls,
  }));
  const gg = w.ghosts();
  out.bodyWhy = gg.hitWhy; out.bodyDist = gg.hitDist;
  const tm = w.timeHitAt ? w.timeHitAt(cx, cy) : null;
  out.marker = tm ? { row: tm.row, sec: tm.sec } : null;
  const on = w.grab();
  w.set('bodies', 0); await settle(900);
  out.off = { verts: w.ghosts().verts, drawn: w.ghosts().drawn, routes: w.ghosts().routes };
  const off = w.grab();
  w.set('bodies', 1); await settle(400);
  // depthTest off is the other half of the answer: if the body paints with walls switched off it IS
  // drawn and something nearer hid it; if it still paints nothing it is not drawn at all.
  w.set('bodythrough', 1); await settle(900);
  out.through = w.ghosts().through;
  const thr = w.grab();
  w.set('bodythrough', 0); await settle(700);
  const at = (f, sx, sy) => {
    const i = ((Math.round(innerHeight - sy - 0.5) * f.dpr) * f.w + Math.round((sx + 0.5) * f.dpr)) * 4;
    return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
  };
  const [x0, y0, x1, y1] = out.box;
  const scan = (f) => {
    let changed = 0, maxd = 0, best = null;
    for (let sy = y0; sy <= y1; sy += 2) {
      for (let sx = x0; sx <= x1; sx += 2) {
        const a = at(f, sx, sy), q = at(off, sx, sy);
        const d = Math.max(Math.abs(a[0] - q[0]), Math.abs(a[1] - q[1]), Math.abs(a[2] - q[2]));
        if (d > 40) changed++;
        if (d > maxd) { maxd = d; best = [sx, sy, a, q]; }
      }
    }
    return { changed, maxd, best };
  };
  out.boxPx = (x1 - x0 + 1) * (y1 - y0 + 1);
  out.withWalls = scan(on);
  out.depthOff = scan(thr);
  out.centreOn = at(on, cx, cy);
  out.centreOff = at(off, cx, cy);
  out.centreThrough = at(thr, cx, cy);
  out.owner = w.ownerAt(cx, cy);
  console.log(JSON.stringify(out));
}
