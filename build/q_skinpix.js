// Does the cast WEAR its skins, in the framebuffer?
//
// The A/B is skinned vs tinted with the SAME bodies, the SAME playhead and the SAME camera. The control
// pair (on, on) says how much the page moves by itself.
//
// Why the diff is asked about the pixels a body covers rather than the whole frame: the world is streaming
// in, so a whole-frame diff is mostly world. Measured the naive way (build/c7_skin_party.txt): 922 pixels
// changed for the skins, and 1,673 for the control pair - a number that answers nothing.
//
// URL knobs: tsec (the second to stand the playhead at), box (half-width of the sample box in CSS px),
// tol (per-channel tolerance, default 3).
const w = __world;
const params = new URLSearchParams(location.search);
const TSEC = params.get('tsec');
const HALF = +params.get('box') || 14;
const TOL = +params.get('tol') || 3;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
// Wait until the loader says it has nothing queued. Without this the control pair (nothing toggled) also
// "changes", because ground keeps arriving under the person - and then no number about skin is believable.
const quiet = async (maxMs = 30000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) { if (w.progress().shape === 'settled') break; await settle(250); }
  return w.progress().shape;
};
const say = (k, v) => console.log(`SKIN ${k} ${JSON.stringify(v)}`);

async function idle(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await raf();
    const pr = w.progress();
    if (!pr.pending && w.skins().loaded) { await settle(700); return pr; }
  }
  return w.progress();
}

say('settings', { bodies: w.settings.bodies, bodySkin: w.settings.bodySkin, bodyOvers: w.settings.bodyOvers,
  time: w.settings.time, at: Math.round(w.settings.timeAt) });
await idle(25000);
if (TSEC !== null) { w.seekSec(+TSEC); w.ghostApply(+TSEC); }
if (w.setTimePlay) w.setTimePlay(0);
await settle(1500);
const g = w.ghosts();
say('skins', w.skins());
say('bodies', g.bodies.filter((b) => b.x != null).map((b) => ({ p: b.player, at: [b.x, b.y, b.z],
  seen: b.seen, skinned: b.skinned, slim: b.slim })));
const live = g.bodies.filter((b) => b.x != null && b.seen !== 'wall');
say('offscreen', g.bodies.filter((b) => b.x != null).length - live.length);
if (!live.length) { say('result', 'every body here is behind ground this page holds: nothing to dress'); throw new Error('hidden'); }

// Screen box per body: soles to crown, the crown being 2.03 blocks up once the second layer is on.
// A body off the edge of the picture has no pixels to ask about; clamping its box to the viewport would
// turn it into a whole-frame diff, which is the world streaming in rather than the person.
const boxes = live.filter((b) => {
  const [fx, fy, fz] = w.project(b.x + 0.5, b.y, b.z + 0.5);
  const [cx, cy] = w.project(b.x + 0.5, b.y + 2.04, b.z + 0.5);
  return !(fz > 1) && [fx, fy, cx, cy].every((v) => Number.isFinite(v))
    && fx >= 0 && fx <= innerWidth && fy >= 0 && fy <= innerHeight
    && cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
}).map((b) => {
  // project() answers [x, y, z] in CSS pixels (the space grab() and ghostHit() speak).
  const [fx, fy, fz] = w.project(b.x + 0.5, b.y, b.z + 0.5);
  const [cx, cy] = w.project(b.x + 0.5, b.y + 2.04, b.z + 0.5);
  const x0 = Math.max(0, Math.min(fx, cx) - HALF), x1 = Math.min(innerWidth, Math.max(fx, cx) + HALF);
  const y0 = Math.max(0, Math.min(fy, cy) - HALF), y1 = Math.min(innerHeight, Math.max(fy, cy) + HALF);
  return { p: b.player, at: [b.x, b.y, b.z], skinned: b.skinned, behind: fz > 1, x0, y0, x1, y1,
    mid: [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)] };
});
say('whereTheyAre', boxes.map((q) => ({ p: q.p, at: q.at, box: [q.x0 | 0, q.y0 | 0, q.x1 | 0, q.y1 | 0],
  who: w.ghostHit(...q.mid) })));

await settle(900);
const A = await w.grab();                              // wearing it
say('quietBeforeA', await quiet());
w.bodyskin(0); say('quietBeforeB', await quiet());
const B = await w.grab();                              // tinted, same bodies
w.bodyskin(1); say('quietBeforeC', await quiet());
const C = await w.grab();                              // wearing it again: the control

function inBox(gr, q, cmp) {
  let n = 0, diff = 0, worst = 0;
  for (let y = Math.ceil(q.y0); y <= q.y1; y++) {
    for (let x = Math.ceil(q.x0); x <= q.x1; x++) {
      const i = (x + y * gr.w) * 4;
      if (i + 3 >= gr.buf.length) continue;
      n++;
      const d = Math.max(Math.abs(gr.buf[i] - cmp.buf[i]), Math.abs(gr.buf[i + 1] - cmp.buf[i + 1]),
        Math.abs(gr.buf[i + 2] - cmp.buf[i + 2]));
      if (d > worst) worst = d;
      if (d > TOL) diff++;
    }
  }
  return { pixels: n, changed: diff, worst };
}

for (const q of boxes) {
  say(`body${q.p}skinnedVsTinted`, inBox(A, q, B));
  say(`body${q.p}control`, inBox(A, q, C));
}
// Second layer: the hat/jacket is a second set of boxes standing half a pixel proud, so toggling it has to
// change pixels on a person and nowhere else.
if (params.has('abovers')) {
  const D = await w.grab();
  w.bodyovers(0); await quiet();
  const E = await w.grab();
  w.bodyovers(1); await quiet();
  say('abOversDone', true);
  for (const q of boxes) say(`body${q.p}jacketVsNoJacket`, inBox(D, q, E));
}
const all = { x0: 0, y0: 0, x1: innerWidth, y1: innerHeight };
say('wholeFrameSkinnedVsTinted', inBox(A, all, B));
say('wholeFrameControl', inBox(A, all, C));
say('result', boxes.some((q) => inBox(A, q, B).changed > 0 && inBox(A, q, C).changed === 0)
  ? 'a person changed where they stand, and did not change when nothing was toggled'
  : 'no body pixel moved on the toggle: the strip is not being worn where a person is');
