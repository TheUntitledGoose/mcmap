// M14 body probe, underground. The cavern is chunk 127,169 at world (2042, 2718): air from y 30 down to
// a floor whose top face is 13, a silt-grass surface 56 blocks above at 69, and a canopy leaf top at 74.
// What this tests that the surface lane cannot: the body falls the whole way down a 60 block shaft
// without hovering or freezing, it walks a cavern floor that is not flat, and the 56 blocks of rock above
// it do not stop the sun from lighting its floor.
//
// Node runs the same phases in `build/dbg-plan.mjs`, and its numbers are the `expect` fields:
//   drop from 20      -> feet 13, 39 of 120 ticks in the air
//   free fall from 150-> feet 74 after 76 blocks, 151/300 air
//   sprint east 3 s   -> 15.2 blocks, feet -11 (the floor drops away), 142/180 air, never in rock
//   jump on the floor -> 1.14 blocks up, 70/72 air
//   Shift alone       -> nowhere
const w = window.__world;
const X = 2042.5, Z = 2718.5;
w.walk(1); w.look(Math.PI / 2, 0);      // east
await new Promise((r) => setTimeout(r, 2000));

const kd = (code) => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const ku = (code) => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const st = () => { const b = w.body(), e = w.eye();
  return { x: b.x, y: b.y, z: b.z, vy: b.vy, onGround: b.onGround, frozen: b.frozen,
    rock: e.clear !== 0 ? e.clear : 0, floor: +e.floor.toFixed(2) }; };

let cur = null;
async function hold(codes, ms) {
  const b0 = w.body();
  cur = { frames: 0, rock: 0, frozen: 0, air: 0, hi: b0.y, lo: b0.y, peakVy: 0 };
  const t0 = performance.now();
  for (const c of codes) kd(c);
  while (performance.now() - t0 < ms) {
    await raf();
    const s = st(); cur.frames++;
    cur.rock += s.rock ? 1 : 0; cur.frozen += s.frozen ? 1 : 0; cur.air += s.onGround ? 0 : 1;
    cur.hi = Math.max(cur.hi, s.y); cur.lo = Math.min(cur.lo, s.y); cur.peakVy = Math.min(cur.peakVy, s.vy);
  }
  for (const c of codes) ku(c);
  const a = w.body();
  return { secs: +((performance.now() - t0) / 1000).toFixed(2),
    dist: +Math.hypot(a.x - b0.x, a.z - b0.z).toFixed(2),
    rise: +(cur.hi - b0.y).toFixed(2), fell: +(b0.y - cur.lo).toFixed(2),
    airFrames: `${cur.air}/${cur.frames}`, frozenFrames: cur.frozen, bodyInRockFrames: cur.rock,
    peakVy: +cur.peakVy.toFixed(1), lastFall: +w.body().lastFall.toFixed(2),
    end: { x: +a.x.toFixed(2), z: +a.z.toFixed(2), feet: +a.y.toFixed(2), vy: +a.vy.toFixed(2),
      floor: st().floor, onGround: a.onGround } };
}

// Set the body down by its feet and let it settle. `free` leaves it there for a drop test.
async function set(feet, free = false) {
  w.drop(X, feet, Z);
  await raf();
  // Settle properly before measuring: a 7 block drop takes a quarter of a second of falling, and a
  // phase that starts mid-fall reports that fall as its own movement.
  if (!free) for (let k = 0; k < 240 && !st().onGround; k++) await raf();
  return st();
}

const out = {};
out.spawn = (() => { const s = st();
  return { x: +s.x.toFixed(2), z: +s.z.toFixed(2), feet: +s.y.toFixed(2), eye: +w.eye().y.toFixed(2),
    floor: s.floor, inRock: s.rock, reach: w.eye().reach }; })();

// 1. settle from seven blocks up: 13 is the cavern floor, and 39 of 120 ticks of Node's run were air.
await set(20);
out.settle = { ...await hold([], 2000), expect: 'feet 13, floor 13' };

// 2. the long fall: 126 blocks up, straight down onto the canopy at 74, then reported.
await set(140, true);
out.fall = { ...await hold([], 6000), expect: 'feet 74 after 66 blocks, terminal -40, 0 frozen (Node: 150 -> 74 in 151/300)' };

// 3. and from higher still, where the shaft has to pass through the silt-grass floor at 69: the body
// does not stop at the surface, it goes down the hole into the cavern at 13.
await set(200, true);
out.shaft = { ...await hold([], 12000), expect: 'feet 74 - the canopy catches a 126 block fall, 0 frozen, never inside a solid' };

// 4. walk the cavern east for 3 s. The floor drops away, so expect air frames and a much lower finish.
const p0 = await set(20);
out.caveSprint = { ...await hold(['ControlLeft', 'KeyW'], 3000), dx: +(st().x - p0.x).toFixed(2),
  dz: +(st().z - p0.z).toFixed(2), expect: '15.2 blocks east, feet near -11, never inside a solid' };

// 5. jump on the cavern floor. A held Space re-jumps, so the rise is one hop and the air is nearly all.
await set(20);
out.caveJump = { ...await hold(['Space'], 1200), expect: 'rise 1.14, feet back on 13' };

// 6. Shift on its own is sneak, not a descent: the feet stay at the floor.
await set(20);
out.caveSneak = { ...await hold(['ShiftLeft'], 2000), expect: 'dist 0, feet 13' };

// 7. free flight is the same mover with the probes off: Space climbs, and leaving flight drops the body
// back onto the floor the voxels say is there.
await set(20);
w.fly(1);
out.flyUp = { ...await hold(['Space'], 1500), expect: 'about +26 blocks (flight is 4x walk speed here, 17.3 b/s); rock frames are expected, walls do not apply' };
w.fly(0);
out.flyBack = { ...await hold([], 6000), expect: 'the first clear box under the roof, then the cavern floor at 13' };

// 8. the view: the request ring follows the body down, so the cavern is streamed, drawn and lit.
const s = w.state;
out.view = { verts: s.verts, tris: s.tris, drawn: s.drawn, chunks: s.chunks, missing: s.missing,
  queued: s.queued, inflight: s.inflight, fps: +s.fps.toFixed(0), walkReach: s.walkReach,
  embeddedFrames: s.embeddedFrames, unstuck: s.unstuck, frozenFrames: s.frozenFrames,
  frameErrors: s.frameErrors };
out.expect_view = 'cavern lit and drawn: verts/drawn non-zero, missing 0, no frame errors';
// `light()` is the section's own fallback level; `litAt()` is the number the mesher paints with.
out.litFloor = w.litAt(Math.floor(X), 13, Math.floor(Z));
out.litCanopy = w.litAt(Math.floor(X), 74, Math.floor(Z));
out.litCaveCeil = w.litAt(Math.floor(X), 29, Math.floor(Z));
return out;
