// M12b tier 3, the user's path: boot armed, let the log play out, then ask what the outline costs.
//
// Everything here is the path a person takes: URL to the house, the time machine on, wait, point.
// The A/B is the outline only - hover off, grab, hover on, grab - so "the highlight is drawn" is a
// pixel count and a bounding box, not an opinion about a screenshot.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 1500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};

// 1. let the armed machine play to the end of the log (that is what arming now does)
out.boot = { time: w.settings.time, play: w.settings.timePlay, drawn: w.time().drawn, quads: w.time().quads };
const t0 = performance.now();
while (performance.now() - t0 < 30000 && w.time().drawn < w.time().quads) { await sleep(50); w.tick(2); }
out.playRanMs = Math.round(performance.now() - t0);
out.atEnd = { drawn: w.time().drawn, quads: w.time().quads, play: w.settings.timePlay, look: w.time().look };
await settle(2500);
out.settled = { verts: w.state.verts, chunks: w.state.chunks, edits: w.hist().edits, markerMb: w.time().bytes };

// 2. aim at a voxel the log actually touched, near where we are looking
const canvas = document.querySelector('canvas');
const probe = w.timeHitProbe(4000);
out.markerProbe = { ok: probe.ok, why: probe.why, xy: probe.probe, expects: probe.expects,
  hit: probe.hit ? { row: probe.hit.row, voxel: probe.hit.voxel } : null, matches: probe.matches };

const sx = probe.probe ? probe.probe[0] : 450, sy = probe.probe ? probe.probe[1] : 300;
const fbOff = w.grab().buf;                       // hover off: the picture with no outline
w.setHover(1);
canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: sx, clientY: sy, bubbles: true }));
for (let i = 0; i < 6; i++) { w.tick(1); await sleep(60); }
const hv = w.hover();
out.hover = { at: hv.at, from: hv.from, changes: hv.changes, ms: +hv.ms.toFixed(2), passes: hv.passes, skips: hv.skips, everyMs: hv.everyMs, why: hv.why };
const g = w.grab();
const fbOn = g.buf;

// 3. the outline in pixels: count and bounding box of what differs
let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, maxd = 0;
for (let p = 0; p < fbOn.length; p += 4) {
  const d = Math.max(Math.abs(fbOn[p] - fbOff[p]), Math.abs(fbOn[p + 1] - fbOff[p + 1]), Math.abs(fbOn[p + 2] - fbOff[p + 2]));
  if (d > 6) {
    n++;
    const i = p / 4, x = i % g.w, y = (i / g.w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (d > maxd) maxd = d;
  }
}
out.outlinePixels = { changed: n, of: g.w * g.h, bbox: n ? [x0, y0, x1, y1] : null, maxDelta: maxd };

// 4. and the same pixel answered by a click, with its cost
out.click = { answer: await w.askAt(sx, sy), why: w.ledger().askWhy, rayMs: +w.hover().clickRayMs.toFixed(1),
  asks: w.ledger().asks, rows: w.ledger().cardRows, total: w.ledger().cardTotal };

// 5. idle cost: with nothing moving, the hover pass must stop paying for its pick
const p0 = w.hover().passes;
await settle(1000);
out.idle = { passes: w.hover().passes - p0, skips: w.hover().skips };

out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
