// M11 walk mode: does the first-person rig work, what does walking cost per frame, and WHICH frame
// hitches?
//
// The page boots in walk mode (?view=walk&goto=...). Then drive it with held keys through three named
// phases - walk, sprint, sink - and ask:
//   1. did the eye move the distance the arithmetic says it should (the keys reach the camera)?
//   2. is the eye the target, i.e. is the mode actually first person (state.dist ~ EYE_DIST)?
//   3. does the eye stand on the ground (eye.y - floor = 1.62) by itself, without a keypress?
//   4. what does each phase cost per frame, and can the worst frames be named by bucket?
//   5. did the work FINISH (settle), or only move elsewhere?
// Frame cost comes from __world.profTotals() raw sums, so per-frame numbers are derived from measured
// totals rather than from differencing rounded means.
// SUPERSEDED by M14 (see HANDOFF `### M14`): this probed the M11 walking *camera*, which had no gravity,
// no collision and no jump. `build/q_body.js` and `build/q_bodycave.js` are the body probes now, and their
// expectations are Node-derived. Kept because HANDOFF `### M11` quotes the numbers this file produced.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = ['view', 'mesh', 'refill', 'shell', 'ov', 'demote', 'count', 'render'];
const totals = () => {
  const p = w.profTotals ? w.profTotals() : (() => {
    const m = w.profAll(); const o = { frames: m.frames };
    for (const k of KEYS) o[k] = m[k] * m.frames;
    return o;
  })();
  const t = { frames: p.frames || 1 };
  for (const k of KEYS) t[k] = p[k];
  return t;
};
// Phases matter: "walking is 180 ms sometimes" is not actionable, "the frame after a dive into rock is"
// is. Every sampled frame is tagged with the phase that was running.
let phase = null, prevT = 0, prevP = null;
const frames = [];                                   // { dt, phase, work, buckets{} }
const sample = () => {
  const t = performance.now(); const p = totals();
  if (phase && prevP) {
    const dn = Math.max(1, p.frames - prevP.frames);
    const b = {}; let sum = 0;
    for (const k of KEYS) { const v = p[k] - prevP[k]; b[k] = +v.toFixed(1); sum += v; }
    frames.push({ dt: +(t - prevT).toFixed(1), phase, work: +(sum / dn).toFixed(1), b });
  }
  prevT = t; prevP = p;
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);
const kd = (code) => dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const ku = (code) => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
const stuck = (s) => {
  const bad = [];
  if (s.ringStuck[0]) bad.push(`ringStuck ${JSON.stringify(s.ringStuck)} ${JSON.stringify(s.ringStuckRows)}`);
  if ((s.meshWave ?? 0) !== 0) bad.push(`wave ${s.meshWave}`);
  if ((s.meshJobs ?? 0) !== 0) bad.push(`jobs ${s.meshJobs}`);
  if ((s.dirty ?? 0) > 0) bad.push(`dirty ${s.dirty}`);
  if ((s.inflight ?? 0) > 0) bad.push(`inflight ${s.inflight}`);
  return bad.join(', ');
};
const pct = (q, arr) => +((arr.slice().sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0).toFixed(1));
const phaseStats = (name) => {
  const f = frames.filter((x) => x.phase === name);
  const dt = f.map((x) => x.dt), work = f.map((x) => x.work);
  return { n: f.length, dtMs: { p50: pct(0.5, dt), p90: pct(0.9, dt), p99: pct(0.99, dt), max: pct(1, dt),
    over33: dt.filter((v) => v > 33).length, over50: dt.filter((v) => v > 50).length },
  workMs: { p50: pct(0.5, work), p90: pct(0.9, work), max: pct(1, work) },
  bucketTotalsMs: Object.fromEntries(KEYS.map((k) => [k, +f.reduce((a, x) => a + x.b[k], 0).toFixed(1)])) };
};

await sleep(4000);
const boot = w.state;
// The spawn has to stand on the ground by itself. A walk that boots at the literal goto height puts the
// viewer in the dirt (or in the air) until they press a key, which is what a `?view=walk&goto=` link is
// supposed to be immune to.
const eSpawn = w.eye();
const spawnStand = {
  eyeY: +eSpawn.y.toFixed(2),
  floor: Number.isFinite(eSpawn.floor) ? +eSpawn.floor.toFixed(2) : null,
  eyeAboveFloor: Number.isFinite(eSpawn.floor) ? +(eSpawn.y - eSpawn.floor - 1).toFixed(2) : null,
};

// --- the mode's own invariants, before any walking ---------------------------------------------
const invariants = {
  walkOn: boot.walkOn, dist: boot.dist, eyeIsTarget: Math.abs(boot.dist - 0.05) < 1e-9,
  reach: boot.walkReach, speed: boot.walkSpeed, sprintMul: boot.walkSprint, snap: boot.walkSnap,
  sharpRingChunks: boot.detailRadius, sharpCeiling: boot.detailCeiling, payloadR: boot.payloadRadius,
  skinChunks: boot.skinRadius, frameError: boot.frameError, bootError: boot.bootError, spawnStand,
};
// mouse-look must clamp at the pole, and the wheel's number must be the skin's reach
const lookMax = w.look(0.4, 99)[1];
const lookMin = w.look(0.4, -99)[1];
w.look(0.4, 0.05);
const reachSet = w.reach(320);
const skinAfterReach = w.state.skinRadius;
w.reach(boot.walkReach);

// --- walk forward for six seconds of real frames -------------------------------------------------
const e0 = w.eye();
phase = 'walk'; const tW = performance.now(); kd('KeyW');
await sleep(6000);
ku('KeyW');
const walkWall = (performance.now() - tW) / 1000;
const e1 = w.eye();
const s1 = w.state;

// sprint for one second: Ctrl is the sprint key, Shift is not. KeyW has to be held again here - the
// first version of this probe held only Ctrl and reported a sprint that moved 0 blocks, which read
// like a broken sprint multiplier and was a broken probe.
kd('ControlLeft'); kd('KeyW');
const eS = w.eye(); phase = 'sprint';
const tS = performance.now();
await sleep(1000);
ku('KeyW'); ku('ControlLeft');
const sprintWall = (performance.now() - tS) / 1000;
phase = null;
const e2 = w.eye();
const sprintDist = Math.hypot(e2.x - eS.x, e2.z - eS.z);

// sinking: Shift must go DOWN, not speed up, and a dive into rock is where a hitch would hide
kd('ShiftLeft');
const eD = w.eye(); phase = 'sink';
const tD = performance.now();
await sleep(800);
ku('ShiftLeft');
const sinkWall = (performance.now() - tD) / 1000;
phase = null;
const e3 = w.eye();
const sank = e3.y - eD.y;
const drift = Math.hypot(e3.x - eD.x, e3.z - eD.z);

// V again must hand the camera back to the orbit rig, not leave the eye stuck at zero distance
w.walk(0);
const orbit = { walkOn: w.state.walkOn, dist: w.state.dist };
w.walk(1);
const backAgain = { walkOn: w.state.walkOn, dist: w.state.dist };

// Pose for the screenshot: a level first-person view from the start column, settled. Without this the
// shot is whatever the movement tests left behind - sunk into a hole, looking at nothing.
w.walkTo(e0.x, e0.y, e0.z);
w.look(0.4, 0.05);
await sleep(1500);

// --- settle: the walking work has to finish, not migrate ----------------------------------------
let waited = 0, why = stuck(w.state);
while (why && waited < 20000) { await sleep(1000); waited += 1000; why = stuck(w.state); }
const s2 = w.state;

const walked = Math.hypot(e1.x - e0.x, e1.z - e0.z);
const r = w.res();
// The worst frames of the whole run, with the buckets that grew in them: this is what turns "walking
// hitches" into "the frame after a dive into rock pays for the cave shell under it".
const worst = frames.slice().sort((a, b) => b.dt - a.dt).slice(0, 6)
  .map((f) => ({ dt: f.dt, phase: f.phase, top: Object.entries(f.b).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`) }));
return {
  parsed: { url: location.search, walkOn: boot.walkOn, reach: boot.walkReach, speed: boot.walkSpeed,
    radius: boot.detailCeiling, detailPixels: s2.detailPixels, lodOn: s2.lodOn,
    skinFloor: boot.skinFloor, workers: s2.workers, workerReady: s2.workerReady,
    aa: s2.aa, drawRes: r.setting, autoRes: r.autoOn },
  invariants: { ...invariants, lookClampMax: lookMax, lookClampMin: lookMin,
    reachSet, skinChunksAfterReach320: skinAfterReach },
  eye: { from: [e0.x, e0.y, e0.z].map((v) => +v.toFixed(2)), to: [e1.x, e1.y, e1.z].map((v) => +v.toFixed(2)),
    floorUnderEye: Number.isFinite(e1.floor) ? +e1.floor.toFixed(2) : null,
    eyeAboveFloor: Number.isFinite(e1.floor) ? +(e1.y - e1.floor - 1).toFixed(2) : null,
    pitch: +e1.pitch.toFixed(3), yaw: +e1.yaw.toFixed(3) },
  move: { walkedBlocks: +walked.toFixed(1), wallS: +walkWall.toFixed(2),
    expectedBlocks: +(s1.walkSpeed * walkWall).toFixed(1),
    sprintBlocks: +sprintDist.toFixed(1), sprintWallS: +sprintWall.toFixed(2),
    sprintExpected: +(s1.walkSpeed * s1.walkSprint * sprintWall).toFixed(1),
    sankBlocks: +sank.toFixed(2), sinkWallS: +sinkWall.toFixed(2), shiftDriftBlocks: +drift.toFixed(2) },
  orbit: { afterVOff: orbit, afterVOn: backAgain },
  settle: { not: why || 'clean', afterS: waited / 1000 },
  phases: { walk: phaseStats('walk'), sprint: phaseStats('sprint'), sink: phaseStats('sink') },
  worstFrames: worst,
  fpsDuringWalk: s1.fps, fpsSettled: s2.fps,
  // A throw inside frameBody drops the rest of that frame, render included. The catch keeps the viewer
  // alive, so a measurement run on a throwing page looks healthy: assert it is 0.
  frameErrors: w.state.frameErrors ?? 0,
  frameError: w.state.frameError ? String(w.state.frameError).slice(0, 160) : null,
  picture: { verts: s2.verts, tris: s2.tris, drawn: s2.drawn, detailMeshes: s2.detailMeshes,
    detailVerts: s2.detailVerts, shellPatches: s2.shellPatches, shellVerts: s2.shellVerts,
    lodTiles: s2.lodTiles, lodVerts: s2.lodVerts, ovOn: s2.ovOn, underFar: s2.underFar },
  data: { chunks: s2.chunks, payloadBytesMB: +(s2.bytesHeld / 1e6).toFixed(1), missing: s2.missing,
    meshBuilds: s2.meshBuilds, meshReused: s2.meshReused, meshMs: s2.meshAvgMs, meshWait: s2.meshWait },
  draw: { scale: +r.scale.toFixed(3), changes: r.changes, gpuMs: +r.gpuMs.toFixed(2), gpuTimer: r.gpuTimer },
};
