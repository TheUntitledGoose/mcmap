// M14: a body falling down a real column, measured against the world's own bytes.
//
// The column is world (2042, 2718) = chunk 127,169 local (10,14), read out of the region file with:
//   node tools/column.mjs --cx 127 --cz 169 --x 10 --z 14 --y1 150 --y0 -60
// which says, top down: leaves at 73, air 71..69, silt_grass_block at 68 (floor top face 69), solid
// stone/diorite/andesite 57..31, then 18 blocks of cave air 30..13, then stone 12..6, then unbroken
// deepslate to the bottom of the world. So the honest answers are: a body released at y=20 stands with
// its feet at 13; a body released at 150 is caught by the canopy; and nothing in this column is
// supposed to stop a fall in mid-air. That last one is the bug being tested for.
// SUPERSEDED by M14 (see HANDOFF `### M14`): this probed the M11 walking *camera*, which had no gravity,
// no collision and no jump. `build/q_body.js` and `build/q_bodycave.js` are the body probes now, and their
// expectations are Node-derived. Kept because HANDOFF `### M11` quotes the numbers this file produced.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kd = (code) => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const ku = (code) => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
const snap = () => { const e = w.eye(), b = w.body();
  return { feet: +e.feet.toFixed(2), eyeY: +e.y.toFixed(2), floor: Number.isFinite(e.floor) ? +e.floor.toFixed(1) : null,
    onGround: e.onGround ? 1 : 0, vy: +b.vy.toFixed(2), fell: +b.fell.toFixed(1),
    cellAtFeet: e.cell, frozen: e.frozenFrames, steps: b.steps, liquid: b.inLiquid ? 1 : 0 }; };

await sleep(5000);
const boot = w.state;
const out = { parsed: { url: location.search, walkOn: boot.walkOn, fly: boot.walkFly,
  gravity: boot.walkGravity, jump: boot.walkJump, speed: boot.walkSpeed, sprint: boot.walkSprint,
  reach: boot.walkReach, cavesOn: boot.cavesOn } };

// ---- A: released inside the cave, above the stone floor at y=12 -> feet belong at 13 ------------
w.walkTo(2042.5, 20, 2718.5);
await sleep(1500);
out.releasedInCave = snap();

// ---- B: the fall from the treetops, traced frame by frame ---------------------------------------
// `hover` counts a frame that had speed but moved nothing and was not standing: that is exactly the
// reported symptom, and it is counted per frame rather than inferred from start and end positions.
w.walkTo(2042.5, 150, 2718.5);
await sleep(60);
const trace = [];
let hover = 0, frozen = 0, prev = null;
const until = Date.now() + 4000;
while (Date.now() < until) {
  await sleep(16);
  const e = w.eye(), b = w.body();
  if (prev) {
    const dy = e.y - prev.y;
    if (Math.abs(dy) < 1e-3 && Math.abs(b.vy) > 1 && !b.onGround) hover++;
    if (e.frozenFrames > 0) frozen++;
    if (Math.abs(dy) > 0.02) trace.push({ y: +e.y.toFixed(2), vy: +b.vy.toFixed(2), g: b.onGround ? 1 : 0 });
  }
  prev = e;
  if (b.onGround && b.fell > 30) break;
}
out.fall = { from: 150, to: +w.eye().feet.toFixed(2), floor: +w.eye().floor.toFixed(1),
  landed: w.body().onGround ? 1 : 0, fell: +w.body().fell.toFixed(1), hoverFrames: hover,
  frozenFrames: frozen, peakVy: Math.min(...trace.map((t) => t.vy)), traceFrames: trace.length,
  trace: trace.filter((t, i) => i % 4 === 0).slice(0, 14) };

// ---- C: the canopy caught it: released from above, the leaves are a floor ----------------------
w.walkTo(2042.5, 150, 2718.5);
await sleep(1200);
out.canopy = snap();

// ---- D: a jump leaves the ground by about 1.25 blocks and comes back ----------------------------
w.walkTo(2042.5, 20, 2718.5);
await sleep(800);
const y0 = w.eye().y;
kd('Space'); await sleep(100); ku('Space');
let peak = y0, airFrames = 0;
const untilD = Date.now() + 2500;
while (Date.now() < untilD) {
  await sleep(16);
  const e = w.eye();
  peak = Math.max(peak, e.y);
  if (!e.onGround) airFrames++; else if (peak > y0 + 0.2) break;
}
out.jump = { rise: +(peak - y0).toFixed(2), airFrames, backOnGround: w.eye().onGround ? 1 : 0,
  driftX: +(w.eye().x - 2042.5).toFixed(2), driftZ: +(w.eye().z - 2718.5).toFixed(2) };

// ---- E: hold descend on the cave floor: solid stone holds, it does not sink or freeze ----------
kd('ShiftLeft');
const untilE = Date.now() + 3000;
let minFeet = w.eye().feet;
while (Date.now() < untilE) { await sleep(20); minFeet = Math.min(minFeet, w.eye().feet); }
ku('ShiftLeft');
out.descendOnFloor = { minFeet: +minFeet.toFixed(2), ...snap() };

// ---- F: walk a stride on the cave floor, then look at what the page is spending -----------------
const before = w.eye();
kd('KeyW'); await sleep(2000); ku('KeyW');
const after = w.eye();
out.stride = { blocks: +Math.hypot(after.x - before.x, after.z - before.z).toFixed(1),
  expected: +(boot.walkSpeed * 2).toFixed(1), feet: +after.feet.toFixed(2),
  onGround: after.onGround ? 1 : 0, floor: Number.isFinite(after.floor) ? +after.floor.toFixed(1) : null,
  cellAtFeet: after.cell };

const s = w.state;
out.data = { chunks: s.chunks, bytesMB: +(s.bytesHeld / 1e6).toFixed(1), missing: s.missing,
  underFar: s.underFar, cavesOn: s.cavesOn, darkcut: s.darkcut };
out.picture = { verts: s.verts, drawn: s.drawn, detailMeshes: s.detailMeshes,
  shellPatches: s.shellPatches, lodTiles: s.lodTiles };
out.health = { frameErrors: s.frameErrors ?? 0, frameError: s.frameError ? String(s.frameError).slice(0, 160) : null,
  fps: +s.fps.toFixed(0) };
return out;
