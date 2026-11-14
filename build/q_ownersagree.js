// Does the page's ANSWER for a pixel match what is actually PAINTED there?
//
// "Draw order is still fucked up" is a claim about two artifacts disagreeing: what you see, and what the
// page says when you click it. Both are measurable. For a pixel: ask the page who owns it (ownerAt runs the
// same pass a click runs), then find out what actually PAINTED there by switching one layer off and diffing
// THAT pixel.
//
//   painted 'body'   switching bodies off changes the pixel
//   painted 'marker' switching the time overlay off changes it
//   painted 'world'  neither does - the ground (or sky) owns it
//
// Agreement is the property. A disagreement in either direction is the thing being photographed.
const w = window.__world;
const out = { framing: location.search };
// A hung probe is indistinguishable from a slow one from outside, and a 420 s timeout that prints nothing is
// worthless. Everything here runs against a wall-clock budget, and progress goes to the console as it happens.
const params = new URLSearchParams(location.search);
const DEADLINE = performance.now() + Number(params.get('budget') || 330) * 1000;
const live = () => performance.now() < DEADLINE;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const render = async () => { await raf(); await raf(); await raf(); };
const grab = () => { const g = w.grab(); return { buf: g.buf, w: g.w, h: g.h, dpr: g.dpr || 1 }; };
const px = (X, sx, sy) => {
  const i = ((X.h - 1 - Math.round(sy * X.dpr)) * X.w + Math.round(sx * X.dpr)) * 4;
  return [X.buf[i], X.buf[i + 1], X.buf[i + 2]];
};
// The threshold has to be smaller than the ACTION WASH on a dark block. A deepslate face lit to rgb 40,40,40
// and washed (0.85, 1.3, 0.85) moves only 12, so a threshold of 12 called a marker that WAS painting
// "not painted" - and 6 of 12 wall disagreements were that. 3 still clears the render's own noise (the
// control pair below is printed at this same threshold, and it is 0 pixels).
const TOL = Number(params.get('tol') || 3);
const changed = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) > TOL;
const wholeDiff = (A, B) => {
  let n = 0;
  for (let i = 0; i < Math.min(A.buf.length, B.buf.length); i += 4) {
    if (Math.max(Math.abs(A.buf[i] - B.buf[i]), Math.abs(A.buf[i + 1] - B.buf[i + 1]),
      Math.abs(A.buf[i + 2] - B.buf[i + 2])) > TOL) n++;
  }
  return n;
};

for (let i = 0; i < 60 && live() && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
// The playhead is a ROW index, and a fresh arm PLAYS: without standing it, the sampling below runs across a
// moving draw range and `drawn` reaches the whole filter, which is exactly the state where a future claim
// cannot be told from a present one. `&seek=` is seconds, and it must be asked for out loud.
const seek = new URLSearchParams(location.search).get('seek');
w.setTimePlay(0);
if (seek !== null) w.seekSec(+seek);
for (let i = 0; i < 60 && live() && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
w.setTimePlay(0);
out.playhead = { sec: w.time().sec, drawn: w.time().drawn, quads: w.time().quads };
out.boot = { loopFrames: w.state.loopFrames, frameErrors: w.state.frameErrors, bootError: w.state.bootError };
console.log('AGREE_HEAD ' + JSON.stringify({ boot: out.boot, playhead: out.playhead, secs: Math.round((DEADLINE - performance.now()) / 1000) }));
await settle(1500);

// A settled control pair, or nothing else in this file means anything.
let base = null, ctrl = null, tries = 0;
for (;;) {
  base = (await render(), grab());
  ctrl = (await render(), grab());
  if (wholeDiff(base, ctrl) < 400 || ++tries > 8 || !live()) break;
  await settle(900);
}
w.setTimePlay(0);
out.stability = { controlPairDiff: wholeDiff(base, ctrl), tries, pixels: ctrl.w * ctrl.h };

const noBody = (w.set('bodies', 0), await render(), grab());
const bodyBack = (w.set('bodies', 1), await render(), grab());
const backAgain = (await render(), grab());          // bodies really came back?
out.restore = { bodyBackDiff: wholeDiff(base, backAgain) };

const noTime = (w.set('time', 0), await render(), grab());
const timeBack = (w.set('time', 1), await render(), grab());
out.timeRestore = { diff: wholeDiff(base, timeBack) };

// A CONTROL PAIR AFTER THE TOGGLES. Switching the overlay off and on rebuilds the marker buffer, and
// resetMarkerLift() gives the fresh copy different lift values, so coplanar duplicate claims land at slightly
// different depths and the frame does not come back identical: 18,277 of 1,024,000 pixels moved across a
// time on/off/on cycle at the party framing. A pixel that moves by itself cannot accuse the pick of anything,
// so it is counted separately and skipped.
const lateA = (await render(), grab());
const lateB = (await render(), grab());
out.lateControl = wholeDiff(lateA, lateB);

const N = Number(new URLSearchParams(location.search).get('n') || 45);
out.samples = []; out.disagree = 0; out.owners = {}; out.paintedKinds = {}; out.tol = TOL;
let asked = 0;
for (let j = 1; j <= 5; j++) {
  for (let k = 1; k <= 5; k++) {
    for (let s = 0; s < Math.ceil(N / 25); s++) {
      const sx = Math.round((innerWidth * k) / 6 + s * 7);
      const sy = Math.round((innerHeight * j) / 6 + s * 5);
      if (sx < 30 || sy < 30 || sx > innerWidth - 30 || sy > innerHeight - 30) continue;
      if (!live()) { out.stopped = `out of budget after ${asked} pixels`; break; }
      // Aim at the CENTRE of the pixel the framebuffer sample reads. A ray at integer x is the left EDGE
      // of that pixel, and an alpha-tested sprite edge can differ between the two - which reads as the
      // page answering a marker it never painted.
      const own = w.ownerAt(sx + 0.5, sy + 0.5);   // the SAME pass a click runs
      asked++;
      const p0 = px(base, sx, sy);
      if (changed(px(lateA, sx, sy), px(lateB, sx, sy))) {
        out.unstable = (out.unstable ?? 0) + 1;
        continue;
      }
      const byBody = changed(p0, px(noBody, sx, sy));
      const byTime = changed(p0, px(noTime, sx, sy));
      // "The overlay changed this pixel" is not "a marker owns it": switching the time machine off also
      // takes back the VOXELS it replayed, so ground repaints. A marker only owns the pixel when the marker
      // ray is actually in it - and pixelHits already ran that ray for the owner answer.
      const replayOnly = byTime && own.markerDist == null;
      if (replayOnly) out.replayPixels = (out.replayPixels ?? 0) + 1;
      const painted = byBody ? 'body' : (byTime && own.markerDist != null) ? 'marker' : 'world';
      // 'nothing' (no layer answered at all) and 'world' are the same picture: neither overlay owns it.
      const agree = painted === own.owner || (painted === 'world' && own.owner === 'nothing');
      out.owners[own.owner] = (out.owners[own.owner] || 0) + 1;
      out.paintedKinds[painted] = (out.paintedKinds[painted] || 0) + 1;
      if (!agree) out.disagree++;
      if (!agree || out.samples.length < 12) {
        out.samples.push({ px: [sx, sy], rgb: p0, owner: own.owner, painted, agree,
          world: own.worldState ?? null, ground: own.detailBlock ?? null,
          markVoxel: own.markerVoxel ?? null,
          sameVoxel: !!(own.markerVoxel && own.detailBlock && own.markerVoxel[0] === own.detailBlock[0]
            && own.markerVoxel[1] === own.detailBlock[1] && own.markerVoxel[2] === own.detailBlock[2]),
          who: own.player ?? null, cube: own.markerCube ?? null, alpha: own.markerAlpha ?? null,
          paints: own.markerPaints ?? null, markFront: own.markFrontDist ?? null,
          drawnLayer: own.worldDrawn ?? null, tie: own.markerTie ?? false,
          coarse: own.markCoarse ?? null,
          dists: { body: own.bodyDist, mark: own.markerDist,
            world: own.worldDist, ground: own.markGroundDist ?? own.detailDist } });
      }
    }
  }
  console.log('AGREE_STEP ' + JSON.stringify({ asked, disagree: out.disagree, owners: out.owners,
    painted: out.paintedKinds, secs: Math.round((DEADLINE - performance.now()) / 1000) }));
  if (out.stopped) break;
}
out.asked = asked;
out.time = w.time(); out.people = w.ghosts();
console.log('AGREE ' + JSON.stringify(out));
