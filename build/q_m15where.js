// build/q_m15where.js -- for one parked body: what does the page's own pick say owns this pixel, and
// does the framebuffer agree? Per framing it logs the pick's answer (including WHICH texture class and
// which state stood in front - opaque rock, a flower, a water film) next to the number of pixels in that
// body's own projected box that its paint actually changed. One page load, one moment.
//
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&gsec=3003&gat=104,119,47" \
//     --wait 14000 --eval-file build/q_m15where.js
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=-59,72,-130&dist=28&time=1&timecls=0&caves=1" \
//     --wait 14000 --eval-file build/q_m15where.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';

const q = new URLSearchParams(location.search).get('gat')?.split(',').map(Number) ?? null;
const g0 = new URLSearchParams(location.search).get('gsec');
// A playhead that is still running moves the bodies between the projection and the answer, so the moment
// is pinned: the URL's second, or the busiest second the log offers.
w.setTimePlay(0);
const sec = g0 != null ? +g0 : w.ghosts().occ?.peakAt ?? null;
if (sec != null) { w.ghostApply(sec); await settle(1500); }
if (q && w.ghosts().bodies.every((x) => x.absent)) {   // a named body needs its chunk before its seat
  w.ghostApply(sec);
  await settle(3000);
}

// The standing bodies this moment offers, shallow first: a body 100 blocks down photographs a mine, not
// a person, so it is the last choice when anything shallower is standing.
function candidates() {
  const all = w.ghosts().bodies.filter((b) => !b.absent);
  const named = q ? all.filter((b) => b.x === q[0] && b.y === q[1] && b.z === q[2]) : [];
  const ground = all.filter((b) => b.seat === 'ground');
  const shallow = ground.filter((b) => (b.down == null || b.down <= 6));
  const deep = ground.filter((b) => (b.down ?? 0) > 6);
  const unknown = all.filter((b) => b.seat === 'unknown');
  return [...named, ...shallow, ...ground.filter((b) => !shallow.includes(b)), ...unknown, ...deep];
}

function boxOf(b) {
  const cs = [];
  for (const ax of [0, 1]) for (const ay of [0, 1.8]) for (const az of [0, 1]) {
    const p = w.project(b.x + ax, b.y + ay, b.z + az);
    cs.push([p[0], p[1]]);
  }
  const bb = [Math.min(...cs.map((p) => p[0])), Math.min(...cs.map((p) => p[1])),
    Math.max(...cs.map((p) => p[0])), Math.max(...cs.map((p) => p[1]))].map(Math.round);
  return bb[0] > 60 && bb[1] > 60 && bb[2] < innerWidth - 60 && bb[3] < innerHeight - 60 ? bb : null;
}

const grab = () => w.grab();
const pxAt = (f, sx, sy) => {
  const i = ((Math.round(innerHeight - sy - 0.5) * f.dpr) * f.w + Math.round((sx + 0.5) * f.dpr)) * 4;
  return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
};
// Two grabs of the same camera, bodies on then off: how many pixels disagree, in the body's own box and
// across the whole frame. A body whose paint never reaches the framebuffer changes none of its box.
function diff(a, b, bb) {
  let inBox = 0, frame = 0, chroma = 0;
  const same = (i) => Math.abs(a.buf[i] - b.buf[i]) <= 6 && Math.abs(a.buf[i + 1] - b.buf[i + 1]) <= 6
    && Math.abs(a.buf[i + 2] - b.buf[i + 2]) <= 6;
  for (let y = bb[1]; y <= bb[3]; y++) {
    for (let x = bb[0]; x <= bb[2]; x++) {
      const i = ((Math.round(innerHeight - y - 0.5) * a.dpr) * a.w + Math.round((x + 0.5) * a.dpr)) * 4;
      if (!same(i)) inBox++;
      const v = pxAt(a, x, y);
      if (Math.max(...v) - Math.min(...v) > 14) chroma++;
    }
  }
  for (let i = 0; i < a.buf.length; i += 4) if (!same(i)) frame++;
  return { inBox, frame, chroma };
}

const list = candidates();
if (!list.length) { console.log(JSON.stringify({ err: 'nobody stands at this moment', ghosts: w.ghosts() })); }
const b0 = list[0];
w.go(b0.x + 0.5, b0.y + 1.0, b0.z + 0.5);
w.orbit(Math.PI / 4, -0.25, 10);
w.sync();
await settle(2600);                        // the chunk under a named body may only arrive now
const again = candidates();
const b = again.find((x) => x.x === b0.x && x.y === b0.y && x.z === b0.z) ?? again[0] ?? b0;
if (b !== b0) { w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5); w.sync(); await settle(1200); }

// The picture's own geometry signature: where four world points land on screen. Camera position alone
// misses a look that is still easing, and an easing look recolours every pixel.
function projSig(b) {
  return [w.project(b.x, b.y, b.z), w.project(b.x + 16, b.y + 4, b.z - 16),
    w.project(b.x - 24, b.y, b.z + 8), w.project(b.x + 4, b.y + 40, b.z + 4)];
}
const projDelta = (a, c) => Math.max(...a.flatMap((p, i) => [Math.abs(p[0] - c[i][0]), Math.abs(p[1] - c[i][1])]));

// How much does a frame disagree with the frame before it, for no reason at all? Counted at several
// thresholds so a ±1 dither is not mistaken for a redraw, over every 4th pixel.
function stat(a, b) {
  let p2 = 0, p6 = 0, p30 = 0, sum = 0, max = 0, n = 0;
  for (let i = 0; i < a.buf.length; i += 16) {
    const d0 = Math.abs(a.buf[i] - b.buf[i]), d1 = Math.abs(a.buf[i + 1] - b.buf[i + 1]);
    const d2 = Math.abs(a.buf[i + 2] - b.buf[i + 2]);
    const m = Math.max(d0, d1, d2);
    n++; sum += m; if (m > max) max = m;
    if (m > 2) p2++; if (m > 6) p6++; if (m > 30) p30++;
  }
  return { p2, p6, p30, mean: +(sum / n).toFixed(2), max, sampled: n };
}

const CAP = +(new URLSearchParams(location.search).get('cap') ?? 18);
const rows = [];
let chosen = null;
for (const pitch of [-0.15, -0.4, 0.15]) {
  for (let k = 0; k < 6 && !chosen && rows.length < CAP; k++) {
    const a = (k / 6) * Math.PI * 2;
    const dx = Math.round(Math.sin(a) * 9), dz = Math.round(Math.cos(a) * 9);
    w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5);
    w.orbit(Math.atan2(-dx, -dz), pitch, 10);
    w.sync();
    await settle(1300);
    const bb = boxOf(b);
    if (!bb) { rows.push({ dx, dz, pitch, offscreen: true }); continue; }
    const cx = Math.round((bb[0] + bb[2]) / 2), cy = Math.round((bb[1] + bb[3]) / 2);
    const own = w.ownerAt(cx, cy);
    const camA = w.camPos();
    const sigA = projSig(b);
    const ctrlA = grab();                       // a control pair with nothing switched at all
    await settle(700);
    const ctrlB = grab();
    const sigB = projSig(b);
    const camB = w.camPos();
    const on = grab();
    w.set('bodies', 0);
    await settle(700);
    const off = grab();
    const sigC = projSig(b);
    const camC = w.camPos();
    w.set('bodies', 1);
    await settle(700);
    // Two grabs only disagree because of the bodies if the camera held still and nothing streamed in
    // between them; a drifting camera recolours the whole picture and fakes a win.
    // Auto-resolution is a second reason the picture changes: it redraws at a different scale, so the
    // two grabs index different buffers and every pixel "differs". Only a same-size pair can be diffed.
    // Three reasons two grabs of the same camera can still disagree: the camera eased (position AND
    // look direction), auto-resolution redrew at another scale, or the picture is not identical frame
    // to frame at all. The control pair - nothing switched - measures that last one.
    const camStable = camA.every((v, i) => Math.abs(v - camC[i]) < 0.01)
      && projDelta(sigA, sigC) < 0.75
      && on.w === off.w && on.h === off.h && on.dpr === off.dpr;
    const d = camStable ? diff(on, off, bb) : { inBox: -1, frame: -1, chroma: -1 };
    // The aimed pixel itself, on and off: a box can hold painted body pixels while the pixel the click
    // answers is rock. Only the aimed pixel tells whether the click's answer is what the frame shows.
    const centreOn = pxAt(on, cx, cy), centreOff = pxAt(off, cx, cy);
    const centreChanged = Math.max(...centreOn.map((v, i) => Math.abs(v - centreOff[i]))) > 6;
    const ctrl = diff(ctrlA, ctrlB, bb);
    const ctrlStat = stat(ctrlA, ctrlB);
    const abStat = stat(on, off);
    const mid = pxAt(on, cx, cy);
    const rec = {
      dx, dz, pitch, box: bb, owner: own.owner, floor: own.floor, rule: own.rule,
      bodyDist: own.bodyDist, markerDist: own.markerDist, worldDist: own.worldDist,
      worldCls: own.worldCls, worldState: own.worldState,
      worldDrawn: own.worldDrawn, worldQuad: own.worldQuad,
      detailDist: own.detailDist, detailState: own.detailState, wall: own.wall,
      changedBox: d.inBox, changedFrame: d.frame, chromaBox: d.chroma, colourAtBoxCentre: mid,
      camStable, cam: camA, dirty: w.state.dirty, verts: w.state.verts,
      projPx: +projDelta(sigA, sigC).toFixed(2),
      centreOn, centreOff, centreChanged,
      ctrlBox: ctrl.inBox, ctrlFrame: ctrl.frame,
      ctrlStat, abStat,
      bufOn: [on.w, on.h, on.dpr], bufOff: [off.w, off.h, off.dpr], res: w.res().rung,
    };
    rows.push(rec);
    console.log('frame ' + JSON.stringify(rec));   // a cut-short search still leaves numbers
    // A framing is only honest when the page's own answer (a person) is also what the picture shows at
    // the pixel being answered: bodies on/off must change that very pixel.
    if (own.owner === 'body' && centreChanged && d.inBox > 2) chosen = rec;
  }
}

const g = w.ghosts();
console.log(JSON.stringify({
  body: [b.x, b.y, b.z], player: b.player, seat: b.seat, down: b.down,
  standing: g.standing, seats: g.seats, under: g.under, deepestDown: g.deepestDown,
  framingsTried: rows.length, gotOne: !!chosen, chosen,
  tried: rows.map((r) => ({ dx: r.dx, dz: r.dz, pitch: r.pitch, owner: r.owner, floor: r.floor,
    cls: r.worldCls, state: r.worldState, drawn: r.worldDrawn, worldDist: r.worldDist,
    changedBox: r.changedBox, centreChanged: r.centreChanged,
    camStable: r.camStable, offscreen: r.offscreen })),
  settings: { through: g.through, rule: g.pickRule, url: location.search },
  tags: [...document.querySelectorAll('#gtags .gtag')].map((e) => e.textContent),
  note: w.ghostNote(),
}, null, 1));
