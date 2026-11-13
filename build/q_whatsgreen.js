/* What paints these green pixels, and what shape is the thing that painted them?
   Frame a build, stand the playhead on a wall-clock second, find green-dominant framebuffer pixels, and ask
   the page for each one: which kind owns the pixel, which world block it hit, and the marker's own AABB.
   Usage: http://127.0.0.1:8765/?goto=-40,72,-122&dist=45&time=1&timecls=0&res=1&noautores --eval-file build/q_whatsgreen.js
   Optional: &want=10 samples, &gmin=1.25 green dominance, &seek=2024-06-01T19:15:02, &rows=16625 */
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const grab = () => w.grab();
const want = +(location.search.match(/want=(\d+)/)?.[1] || 10);
const gmin = +(location.search.match(/gmin=([\d.]+)/)?.[1] || 1.25);
const out = {};
out.time0 = w.time();
// stand the playhead where the screenshot stood: a wall-clock second, or a filter row index
const seek = location.search.match(/seek=([^&]+)/)?.[1];
const rows = location.search.match(/rows=(\d+)/)?.[1];
if (rows) out.seek = { rows: +rows, drawn: w.seekRow(+rows) };
else if (seek) {
  const base = w.time().base;
  const sec = Math.floor(Date.parse(seek) / 1000) - base;
  out.seek = { seek, base, sec, drawn: w.seekSec(sec) };
}
for (let i = 0; i < 40 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
for (let i = 0; i < 8; i++) await settle(400);
out.time1 = w.time();
const g = grab();
out.frame = [g.w, g.h, g.dpr];
const px = (x, y) => { const o = (y * g.w + x) * 4; return [g.buf[o], g.buf[o + 1], g.buf[o + 2]]; };
// green-dominant pixels, sampled on a coarse lattice so hits spread over the picture
const hits = [];
for (let y = 20; y < g.h - 20; y += 5) {
  for (let x = 20; x < g.w - 20; x += 5) {
    const [r, gg, b] = px(x, y);
    if (gg > 60 && gg > r * gmin && gg > b * gmin) hits.push([x, y, r, gg, b]);
  }
}
out.greenPixelsSampled = hits.length;
// keep hits spread out: one per 90x90 cell, taking the greenest
const byCell = new Map();
for (const h of hits) {
  const k = `${Math.floor(h[0] / 90)},${Math.floor(h[1] / 90)}`;
  const prev = byCell.get(k);
  if (!prev || h[3] - Math.max(h[1], h[2]) > prev[3] - Math.max(prev[1], prev[2])) byCell.set(k, h);
}
const picks = [...byCell.values()].sort((a, b) => (b[3] - Math.max(b[1], b[2])) - (a[3] - Math.max(a[1], a[2])))
  .slice(0, want);
out.samples = picks.map(([x, y, r, gg, b]) => {
  const dpr = g.dpr || 1;
  const sx = x / dpr, sy = y / dpr;
  const own = w.ownerAt(sx, sy);
  const box = w.timeMarkerBox(sx, sy);
  return {
    px: [x, y], rgb: [r, gg, b],
    owner: own.owner,
    world: own.world ? { block: own.world.block, drawn: own.world.drawn, cls: own.world.cls, d: own.world.dist } : null,
    marker: box ? {
      voxel: box.voxel, name: box.name, action: box.action, quads: box.quads, drawn: box.drawn,
      aabb: box.aabb, overVoxel: box.overVoxel, repeat: box.repeat, row: box.row, sec: box.sec,
    } : null,
    markerDist: own.markerDist ?? null,
  };
});
out.counts = { drawn: w.time().drawn, quads: w.time().quads, verts: w.time().verts };
out.time2 = w.time();
console.log('GGREEN ' + JSON.stringify(out));
return out;
