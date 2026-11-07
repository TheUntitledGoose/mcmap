// M12b.2 acceptance: the time machine in a real browser, measured rather than watched.
//
// The claims, in the order the probe takes them:
//   * the timeline arrives, decodes, and becomes ONE mesh, and the page reports what it cost;
//   * the playhead is a draw range: moving it 1000 times costs far less than one rebuild, and the drawn
//     count tracks the cursor rather than the frame;
//   * the mesh really is drawn - a same-frame A/B on renderer.info, not "a mesh exists";
//   * the picture changes between two instants at one camera, counted in pixels and in colours the world
//     itself does not wear;
//   * a filter change is the only rebuild, and each filter's cost is the number the panel promises;
//   * playing the whole history holds a frame rate, at one player AND at the whole dimension.
//
// Run:
//   node tools/browser-probe.mjs --gpu --url "http://127.0.0.1:8765/?time=1&timecls=2&goto=-40,72,-120" \
//     --eval-file build/q_time.js --wait 12000 --shot 900x500 --out build/shot_time_a.png
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) await raf(); };
const out = { url: location.href };

// The URL asked for the layer, so boot fetched it. Wait for that instead of re-fetching: a second
// timeLoad() here would measure a warm cache, not the boot path.
for (let i = 0; i < 240 && !w.time().tl && !w.time().err; i++) await raf();
out.boot = w.time();
if (!out.boot.tl) return out;
out.calendar = { activeDays: out.boot.activeDays, busyDay: out.boot.busyDay, busyN: out.boot.busyN,
  spanDays: +(out.boot.span / 86400).toFixed(1) };

// Stand over the loudest chunk the ledger knows about (cx -3, cz -8 -> world -48..-33, -128..-113).
w.go(-40, 72, -120);
w.orbit(0.7, 0.95, 240);
await settle(60);
out.camera = { cam: w.camPos(), dist: w.settings.dist, look: [-40, 72, -120] };

// ---- the playhead: a cursor over rows, and the counts it produces
const Q = out.boot.quads;
out.sweep = [];
for (const f of [0, 0.01, 0.05, 0.25, 0.5, 0.75, 1]) {
  w.timeSeekRow(Math.round(f * (Q - 1)));
  await settle(2);
  const t = w.time();
  out.sweep.push({ permille: w.timePermille(), drawn: t.drawn, quads: t.quads, range: t.drawRange,
    tris: t.drawn * 2, sec: t.sec });
}
let moves = 0;
const t0 = performance.now();
for (let k = 0; k < 1000; k++) { w.timeApply(); moves++; }
out.playheadCost = { moves, ms: +(performance.now() - t0).toFixed(2) };

// ---- is it drawn? Same-frame A/B on renderer.info, with nothing else moving.
const g = w.scene.children.find((c) => c.name === 'ledger');
const timeMesh = () => g.children.find((c) => c.name === 'ledger-time');
out.group = { name: g?.name, children: g?.children.map((c) => c.name) ?? null };
const info = w.renderer.info;
const frame = () => { w.tick(1); return { calls: info.render.calls, tris: info.render.triangles }; };
w.timeSeekRow(Q - 1);
const on = [], off = [];
for (let i = 0; i < 3; i++) {
  timeMesh().visible = false; off.push(frame());
  timeMesh().visible = true; on.push(frame());
}
const T = w.time();
out.ab = { on, off, delta: on.map((v, i) => ({ calls: v.calls - off[i].calls, tris: v.tris - off[i].tris })),
  expect: { calls: 1, tris: 2 * T.drawn }, drawn: T.drawn, verts: T.verts };

// ---- the picture A/B at one camera: the first logged change against the last
w.timeSeekRow(0); await settle(4);
const A = w.grab();
w.timeSeekRow(Q - 1); await settle(4);
const B = w.grab();
let diff = 0, place = 0, brk = 0;
for (let i = 0; i < A.buf.length; i += 4) {
  const r = A.buf[i], gg = A.buf[i + 1], b = A.buf[i + 2];
  const r2 = B.buf[i], g2 = B.buf[i + 1], b2 = B.buf[i + 2];
  if (Math.abs(r - r2) + Math.abs(gg - g2) + Math.abs(b - b2) > 24) diff++;
  // the place colour is green-led and the world's own greens are darker and bluer, and with the cursor at
  // the end and the filter on places a green-led pixel here is a decal
  if (g2 > 140 && g2 - r2 > 40 && g2 - b2 > 40) place++;
  if (r2 > 190 && r2 - g2 > 90 && r2 - b2 > 90) brk++;
}
out.pixels = { size: [A.w, A.h], diff, placePx: place, breakPx: brk,
  shareOfFrame: +(diff / (A.w * A.h) * 100).toFixed(2) };

// ---- a filter change is the only rebuild, and each one is a number
const filt = [];
for (const [cls, who, label] of [[2, 0, 'place, anybody'], [3, 0, 'break, anybody'],
  [0, 0, 'every change'], [2, 1, 'place, playerA']]) {
  w.settings.timeCls = cls; w.settings.ledgerWho = who;
  const r0 = performance.now();
  w.timeRebuild();
  const t = w.time();
  filt.push({ label, cls, who, ms: +(performance.now() - r0).toFixed(1), quads: t.quads,
    other: t.other, cur: t.cur, bufferMB: +(t.bytes / 1048576).toFixed(2) });
}
out.filters = filt;

// ---- x-ray is a material flag on this layer too
w.set('ledgerXray', false); await settle(2);
out.xray = { terrainHides: w.time().depthTest };
w.set('ledgerXray', true); await settle(2);
out.xray.paintsOver = w.time().depthTest;

// ---- play it at each of the two bills that matter, and measure the frames a person would feel
async function playTest(cls, who, label) {
  w.settings.timeCls = cls; w.settings.ledgerWho = who;
  w.timeRebuild();
  const n = w.time().quads;
  w.settings.timeSpeed = Math.round(n / 4);      // this filter's whole history in 4 seconds
  w.timeSeekRow(0);
  w.setTimePlay(true);
  const t1 = performance.now();
  let frames = 0;
  while (performance.now() - t1 < 6000 && w.time().playing) { await raf(); frames++; }
  const wall = (performance.now() - t1) / 1000;
  const t = w.time();
  w.setTimePlay(false);
  return { label, quads: n, rate: w.settings.timeSpeed, fps: +(frames / wall).toFixed(1),
    seconds: +wall.toFixed(2), cur: Math.round(t.cur), drawn: t.drawn, playing: t.playing };
}
out.play = [];
out.play.push(await playTest(2, 1, 'place, playerA'));
out.play.push(await playTest(2, 0, 'place, anybody'));
out.play.push(await playTest(0, 0, 'every change, whole dimension'));

// ---- M and K do what the key line says
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
await settle(2);
out.kKey = { playing: w.time().playing };
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
await settle(3);
out.mKey = { on: w.time().on, children: g.children.map((c) => c.name) };
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
await settle(6);
out.mKeyBack = { on: w.time().on, tl: w.time().tl, quads: w.time().quads, kb: w.time().kb };
out.panelKeys = w.panelKeys().filter((k) => /^time/.test(k));
out.note = w.timeNote();
return out;
