// M11 acceptance, the shape the plan asked for: walk INTO a cave and back, on a real GPU, and report
// whether the near-field machinery (payload ring, `underFar` stand-down, `buried` culling) held up.
//
// Cave coordinates come from the payload cache, not a guess:
//   node build/find-caves.mjs --near 150,170 --n 12
//     chunk 127,175  surface 82  enclosed 838/838  lit 250  -> goto 2040,4,2808
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
let phase = null, prevT = 0, prevP = null;
const frames = [];
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
const stats = (name) => {
  const dt = frames.filter((f) => f.phase === name).map((f) => f.dt);
  return { n: dt.length, p50: pct(0.5, dt), p90: pct(0.9, dt), p99: pct(0.99, dt), max: pct(1, dt),
    over33: dt.filter((v) => v > 33).length, over50: dt.filter((v) => v > 50).length };
};

await sleep(5000);
const boot = w.state;
const inCave = { walkOn: boot.walkOn, dist: boot.dist, reach: boot.walkReach,
  underFar: boot.underFar, eye: w.eye(), payloadR: boot.payloadRadius };

// six seconds in, six seconds back out: the round trip is the acceptance, not the arrival
kd('KeyW'); phase = 'in';
const a0 = w.eye(); const tIn = performance.now();
await sleep(6000);
ku('KeyW');
const inWall = (performance.now() - tIn) / 1000;
const a1 = w.eye();
const sMid = w.state;
kd('KeyS'); phase = 'out';
const tOut = performance.now();
await sleep(6000);
ku('KeyS');
const outWall = (performance.now() - tOut) / 1000;
const a2 = w.eye();
phase = null;

// Pose inside the cavern for the screenshot: the round trip ends on the surface, and the shot is meant
// to show what a cave actually looks like from the inside at eye height.
w.walkTo(a0.x, a0.y, a0.z);
w.look(0.7, 0.0);
await sleep(1500);
const atPose = w.eye();
const poseState = w.state;

let waited = 0, why = stuck(w.state);
while (why && waited < 20000) { await sleep(1000); waited += 1000; why = stuck(w.state); }
const s2 = w.state;
const worst = frames.slice().sort((x, y) => y.dt - x.dt).slice(0, 5)
  .map((f) => `${f.dt}ms ${f.phase} [${Object.entries(f.b).sort((x, y) => y[1] - x[1]).slice(0, 2)
    .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' ')}]`);
return {
  parsed: { url: location.search, lodOn: s2.lodOn, workers: s2.workers, workerReady: s2.workerReady,
    aa: s2.aa, cavesOn: s2.cavesOn, darkcut: s2.darkcut, surfaceOn: s2.surfaceOn },
  atBoot: inCave,
  round: { inBlocks: +Math.hypot(a1.x - a0.x, a1.z - a0.z).toFixed(1), inWallS: +inWall.toFixed(2),
    expectedIn: +(boot.walkSpeed * inWall).toFixed(1),
    backToStartBlocks: +Math.hypot(a2.x - a0.x, a2.z - a0.z).toFixed(1),
    eyeIn: [a1.x, a1.y, a1.z].map((v) => +v.toFixed(1)),
    eyeOut: [a2.x, a2.y, a2.z].map((v) => +v.toFixed(1)),
    floorIn: Number.isFinite(a1.floor) ? +a1.floor.toFixed(1) : null,
    floorOut: Number.isFinite(a2.floor) ? +a2.floor.toFixed(1) : null },
  underground: { underFarMid: sMid.underFar, underFarSettled: s2.underFar,
    darkcutOn: s2.darkcut, cavesOn: s2.cavesOn,
    detailVertsMid: sMid.detailVerts, detailVertsSettled: s2.detailVerts,
    shellVertsSettled: s2.shellVerts, lodVertsSettled: s2.lodVerts,
    ovOn: s2.ovOn },
  frames: { in: stats('in'), out: stats('out') },
  worst,
  fps: { walking: sMid.fps, settled: s2.fps },
  atPose: { eye: [atPose.x, atPose.y, atPose.z].map((v) => +v.toFixed(1)),
    floor: Number.isFinite(atPose.floor) ? +atPose.floor.toFixed(1) : null,
    underFar: poseState.underFar, detailVerts: poseState.detailVerts, verts: poseState.verts,
    drawn: poseState.drawn },
  settle: { not: why || 'clean', afterS: waited / 1000 },
  data: { chunks: s2.chunks, payloadBytesMB: +(s2.bytesHeld / 1e6).toFixed(1), missing: s2.missing,
    meshBuilds: s2.meshBuilds, meshReused: s2.meshReused },
  picture: { verts: s2.verts, drawn: s2.drawn, detailMeshes: s2.detailMeshes,
    shellPatches: s2.shellPatches, lodTiles: s2.lodTiles },
  frameErrors: w.state.frameErrors ?? 0,
  frameError: w.state.frameError ? String(w.state.frameError).slice(0, 160) : null,
};
