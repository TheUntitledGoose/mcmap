// Is the ledger overlay actually drawn, and does it change the picture? `LEDGER.drawn` only means a
// mesh exists; the honest counts come from GL itself.
//
// Two measurements:
//  * a same-frame A/B of `renderer.info`: one frame with the overlay hidden, one with it shown, with
//    nothing else moving. That is how "one decal mesh, one draw call, two triangles a chunk" gets
//    checked instead of asserted. (An earlier acceptance probe compared two different frames while the
//    world was still streaming and reported 234,150 triangles for a 40,644-triangle overlay: true but
//    meaningless.)
//  * a pixel A/B: the same camera with the overlay on and off, counting the pixels that differ and how
//    many of them are ramp colours the world itself does not wear.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) await raf(); };
const out = { url: location.href };

// Stand over the loudest chunk in the save so the overlay is the biggest thing on screen.
// `ledgerFind` ranks what is painted and moves the camera to the loudest of it; the orbit afterwards
// is what decides how much world shares the frame with it.
w.setLedger(true);
await w.ledgerLoad();
w.ledgerFind();
w.orbit(0.7, 1.05, 260);
await settle(90);

const g = w.scene.children.find((c) => c.name === 'ledger');
out.group = { name: g?.name, children: g?.children.map((c) => c.name) ?? null,
  visible: g?.visible };

const info = w.renderer.info;
const frame = () => { w.tick(1); return { calls: info.render.calls, tris: info.render.triangles }; };
const on = [], off = [], kept = [];
for (let i = 0; i < 3; i++) {
  g.visible = false; off.push(frame()); kept.push(g.visible);
  g.visible = true; on.push(frame());
}
const L = w.ledger();
out.ab = { on, off, keptAllFalse: kept.every((v) => v === false),
  delta: on.map((v, i) => ({ calls: v.calls - off[i].calls, tris: v.tris - off[i].tris })),
  expect: { calls: 1, tris: 2 * L.quads }, quads: L.quads, verts: L.verts ?? null };

// The pins are a second object: a line cage over each hotspot on the tour.
w.ledgerFind();
await settle(8);
const pins = g.children.find((c) => c.name === 'ledger-pins');
let pinDelta = null;
if (pins) {
  const a = (() => { pins.visible = false; return frame(); })();
  const b = (() => { pins.visible = true; return frame(); })();
  pinDelta = { calls: b.calls - a.calls, lines: pins.geometry.attributes.position.count / 2,
    verts: pins.geometry.attributes.position.count };
}
out.pins = pinDelta;

// ---- the picture A/B. grab() renders, so both samples are freshly drawn at the same camera.
const shot = () => { const s = w.grab(); return s; };
const A = shot(), B = (() => { const keep = g.visible; g.visible = false; const s = shot(); g.visible = keep; return s; })();
const diffPx = (() => {
  let diff = 0, hot = 0, aHot = 0;
  for (let i = 0; i < A.buf.length; i += 4) {
    const r = A.buf[i], gg = A.buf[i + 1], b = A.buf[i + 2];
    const r2 = B.buf[i], g2 = B.buf[i + 1], b2 = B.buf[i + 2];
    if (Math.abs(r - r2) + Math.abs(gg - g2) + Math.abs(b - b2) > 24) diff++;
    // hot amber / red: the ramp's loud end, which the world's own palette does not reach
    if (r > 150 && b < 90 && r - gg > 40) hot++;
    if (r2 > 150 && b2 < 90 && r2 - g2 > 40) aHot++;
  }
  return { diff, overlayHot: hot - aHot, withOverlayHot: hot, withoutOverlayHot: aHot };
})();
out.pixels = { size: [A.w, A.h], ...diffPx, shareOfFrame: +(diffPx.diff / (A.w * A.h) * 100).toFixed(2) };

// ---- and a filter really changes the frame, not just the vertex counts
w.set('ledgerMin', 400);
await settle(4);
const C = shot();
let vsB = 0;
for (let i = 0; i < C.buf.length; i += 4) {
  if (Math.abs(C.buf[i] - B.buf[i]) + Math.abs(C.buf[i + 1] - B.buf[i + 1]) + Math.abs(C.buf[i + 2] - B.buf[i + 2]) > 24) vsB++;
}
out.filterPixels = { quads: w.ledger().quads, cells: w.ledger().cells, dropped: w.ledger().dropped,
  diffAgainstOff: vsB, sameBytes: true };
w.set('ledgerMin', 1);
await settle(4);

// ---- x-ray is a material flag, and the flag is the whole feature
w.set('ledgerXray', false);
await settle(4);
out.xray = { depthTest: (() => { const m = g.children.find((c) => c.name === 'ledger-heat')?.material;
  return { depthTest: m.depthTest, transparent: m.transparent, vertexColors: !!m.vertexColors,
    side: m.side, blending: m.blending }; })() };
w.set('ledgerXray', true);
// ---- Escape dismisses the card and the markers; the ranking stays, so F can resume the same tour
window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
await settle(3);
out.escape = { children: g.children.map((c) => c.name), cardGone: !document.querySelector('.lcard') };
w.ledgerFind();
await settle(6);
out.resume = { children: g.children.map((c) => c.name) };

// ---- and the heat layer really goes away: `markers only` is the state the panel offers on purpose
w.setLedger(false);
await settle(4);
out.after = { children: g.children.map((c) => c.name), drawn: w.ledger().drawn, groupVisible: g.visible,
  markersOnly: g.children.length === 1 && g.children[0].name === 'ledger-pins' };
return out;
