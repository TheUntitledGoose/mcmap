// M14 the body, on foot, on a lane that build/find-lane.mjs proved is clear for 34 blocks.
//   ?view=walk&goto=176.5,65,176.5          (feet land on 64, +x is yaw pi/2)
//
// Every expectation in here is the number build/dbg-plan.mjs measures over the same world bytes in Node
// for the same coordinate and the same seconds. A browser run that disagrees is the finding; agreeing
// means the page's payload, collision table and physics are the same world the tests cover.
//
//   jump      rise 1.14, 70/72 frames off the floor (Space held: it bunny-hops, like the game)
//   sprint    11.2 blocks in 2 s     (5.613 b/s)
//   walk      17.3 blocks in 4 s     (4.317 b/s)
//   sneak      2.6 blocks in 2 s     (1.3 b/s)
//   run out   28.2 blocks in 10 s, then the lane ends and it stops there
//   free fall from feet 140 lands on 64, peak speed the 40 b/s terminal, 0 frozen frames
const w = window.__world;
const LANE = { x: 176.5, z: 176.5, feet: 64 };
const KEYS = ['view', 'mesh', 'refill', 'shell', 'ov', 'demote', 'count', 'render'];
const pct = (q, arr) => +(arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0).toFixed(1);

let phase = null, prevT = 0, prevP = null;
const frames = [];
const totals = () => { const p = w.profTotals(); const t = { frames: p.frames || 1 }; for (const k of KEYS) t[k] = p[k]; return t; };
const sample = () => {
  const t = performance.now(); const p = totals();
  if (phase && prevP) {
    const b = {}; let sum = 0;
    for (const k of KEYS) { const v = p[k] - prevP[k]; b[k] = +v.toFixed(1); sum += v; }
    frames.push({ dt: +(t - prevT).toFixed(1), phase, work: +(sum / Math.max(1, p.frames - prevP.frames)).toFixed(1), b });
  }
  prevT = t; prevP = p;
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);
const kd = (code) => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const ku = (code) => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));

// Hold keys for `ms` of wall clock, sampling the body every frame. `inRock` is the real invariant: the
// 0.6 x 1.8 box must never overlap a solid voxel, which is what `eye().clear` answers.
async function hold(codes, ms, name) {
  phase = name;
  const b0 = w.body();
  const t0 = performance.now();
  let apex = b0.y, low = b0.y, frozen = 0, inRock = 0, air = 0, n = 0;
  for (const c of codes) kd(c);
  while (performance.now() - t0 < ms) {
    await new Promise((r) => requestAnimationFrame(r));
    const e = w.eye(), b = w.body(); n++;
    if (!b.onGround) air++;
    if (b.frozen) frozen++;
    low = Math.min(low, b.y); apex = Math.max(apex, b.y);
    if (e.clear !== 0) inRock++;
  }
  for (const c of codes) ku(c);
  phase = null;
  const a = w.body();
  return { secs: +((performance.now() - t0) / 1000).toFixed(2),
    dist: +Math.hypot(a.x - b0.x, a.z - b0.z).toFixed(2),
    rise: +(apex - b0.y).toFixed(2), fell: +(b0.y - low).toFixed(2),
    airFrames: `${air}/${n}`, frozenFrames: frozen, bodyInRockFrames: inRock,
    end: { x: +a.x.toFixed(2), feet: +a.y.toFixed(2), vy: +a.vy.toFixed(2), onGround: a.onGround } };
}

// Put the body back at the start of the lane by its feet, at rest, and let one frame settle.
async function reset() {
  w.drop(LANE.x, LANE.feet, LANE.z);
  await new Promise((r) => requestAnimationFrame(r));
  w.tick();
  return w.body();
}

const out = {};
w.walk(1); w.look(Math.PI / 2, 0);
await new Promise((r) => setTimeout(r, 2000));
const e0 = w.eye(), b0 = w.body();
out.spawn = { x: +e0.x.toFixed(2), z: +e0.z.toFixed(2), feet: +b0.y.toFixed(2), eye: +e0.y.toFixed(2),
  eyeAboveFeet: +(e0.y - b0.y).toFixed(2), floor: +e0.floor.toFixed(2), onGround: b0.onGround,
  clear: e0.clear, frozenFrames: e0.frozenFrames, fly: e0.fly, reach: e0.reach };

out.jump = await hold(['Space'], 1200, 'jump');
out.jumpExpect = 'rise 1.14, most frames off the floor';
out.sprint = await (async () => { await reset(); return hold(['ControlLeft', 'KeyW'], 2000, 'sprint'); })();
out.sprintExpect = 11.2;
out.walk4 = await (async () => { await reset(); return hold(['KeyW'], 4000, 'walk'); })();
out.walk4Expect = 17.3;
out.sneak = await (async () => { await reset(); return hold(['ShiftLeft', 'KeyW'], 2000, 'sneak'); })();
out.sneakExpect = 2.6;

// Run the lane out: 10 s of sprint, then keep the key down for 4 s more. The body must stop at the end
// of the lane, not creep through it or vibrate.
await reset();
out.runout = await hold(['ControlLeft', 'KeyW'], 10000, 'runout');
out.runoutExpect = 28.2;
const tail = await hold(['ControlLeft', 'KeyW'], 4000, 'wall');
out.wall = { extra: tail.dist, feet: tail.end.feet, onGround: tail.end.onGround,
  bodyInRockFrames: tail.bodyInRockFrames, expect: 'extra 0 - a wall stops a body' };

// A fall from a known height with vy 0, bounded so a hover is reported rather than waited out.
await reset();
phase = 'fall';
const f0 = w.body();
w.drop(f0.x, 140, f0.z);
const t0 = performance.now();
let air = 0, frozen = 0, maxVy = 0, frames2 = 0, landed = 0;
while (performance.now() - t0 < 8000) {
  await new Promise((r) => requestAnimationFrame(r));
  const b = w.body(); frames2++;
  if (!b.onGround) air++;
  if (b.frozen) frozen++;
  maxVy = Math.min(maxVy, b.vy);
  if (b.onGround && frames2 > 3) { landed = b.lastFall; break; }
}
phase = null;
const f1 = w.body();
out.fall = { from: 140, to: +f1.y.toFixed(2), lastFall: +landed.toFixed(2), airFrames: `${air}/${frames2}`,
  secs: +((performance.now() - t0) / 1000).toFixed(2), peakVy: +maxVy.toFixed(1), frozenFrames: frozen,
  onGround: f1.onGround, expect: 'lands at feet 64 after 76 blocks, peak vy -40 (terminal), 0 frozen' };

for (const k of ['jump', 'sprint', 'walk', 'sneak', 'runout', 'wall', 'fall']) {
  const f = frames.filter((x) => x.phase === k).map((x) => x.dt);
  out[`${k}Ms`] = f.length ? { n: f.length, p50: pct(0.5, f), p90: pct(0.9, f), p99: pct(0.99, f),
    max: pct(1, f), over33: f.filter((v) => v > 33).length, over50: f.filter((v) => v > 50).length } : { n: 0 };
}
const worst = frames.slice().sort((a, b) => b.dt - a.dt)[0];
out.worst = worst ? { dt: worst.dt, phase: worst.phase, work: worst.work, buckets: worst.b } : null;

const st = w.state;
out.state = { walkOn: st.walkOn, walkFly: st.walkFly, fps: +st.fps.toFixed(0), frameErrors: st.frameErrors,
  feet: st.feet, eye: st.eye.map((v) => +v.toFixed(2)), vy: st.vy, lastFall: st.lastFall, floorY: st.floorY,
  frozenFrames: st.frozenFrames, onGround: st.onGround, chunks: st.chunks,
  payloadMB: +(st.bytesHeld / 1048576).toFixed(1), vertsM: +(st.detailVerts / 1e6).toFixed(2),
  drawn: st.drawn, underFar: st.underFar, cavesOn: st.cavesOn, missing: st.missing,
  sneak: st.walkSneak, jump: st.walkJump, gravity: st.walkGravity, speed: st.walkSpeed, sprintMul: st.walkSprint };
return out;
