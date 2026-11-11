// Where does a body actually get painted? A frame at the mine (bodies on) reported the body answering the
// ray at its own pixel while the colour buffer showed rock there: zero changed pixels inside the body's
// projected box, 1,121 changed pixels elsewhere in the frame. This probe parks at one body and asks, per
// layer that could be covering it, how many pixels of that body's own projected box the framebuffer shows.
//
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=-59,72,-130&dist=28&time=1&timecls=0&caves=1" \
//     --wait 14000 --eval-file build/q_m15pix.js > build/m15_pix.txt 2>&1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);

const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';

// Park at a body that the ray says is standing in the open: the peak second, the shallowest ground-seated
// body nearest the house framing the mine report came in on.
const peak = w.ghosts().occ ? w.ghosts().occ.peakAt : null;
w.setTimePlay(0);
w.ghostApply(peak);
await settle(2500);
const near = (b) => Math.max(Math.abs(b.x + 59), Math.abs(b.z + 130));
const list = w.ghosts().bodies.filter((b) => !b.absent && b.seat === 'ground').sort((a, b) => near(a) - near(b));
const b = list[0];
if (!b) { console.log(JSON.stringify({ err: 'no ground-seated body at the peak' })); }

const fr = [];
for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  for (const pitch of [-0.35, -0.7]) {
    w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5);
    w.orbit(Math.atan2(-dx, -dz), pitch, 10);
    w.sync();
    await settle(400);
    const cs = [];
    for (const ax of [0, 1]) for (const ay of [0, 1.8]) for (const az of [0, 1]) {
      const p = w.project(b.x + ax, b.y + ay, b.z + az);
      cs.push([p[0], p[1]]);
    }
    const bb = [Math.min(...cs.map((p) => p[0])), Math.min(...cs.map((p) => p[1])),
      Math.max(...cs.map((p) => p[0])), Math.max(...cs.map((p) => p[1]))].map(Math.round);
    if (bb[0] > 60 && bb[1] > 60 && bb[2] < innerWidth - 60 && bb[3] < innerHeight - 60) {
      fr.push({ dx, dz, pitch, bb, at: w.ownerAt(Math.round((bb[0] + bb[2]) / 2), Math.round((bb[1] + bb[3]) / 2)) });
    }
  }
}
if (!fr.length) { console.log(JSON.stringify({ err: 'no in-frame framing', bodies: w.ghosts().bodies })); }
const use = fr.find((f) => f.at.owner === 'body') || fr[0];
w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5);
w.orbit(Math.atan2(-use.dx, -use.dz), use.pitch, 10);
w.sync();
await settle(2200);
w.ghostApply(peak);
await settle(800);

const grab = () => w.grab();
const paint = (base, f) => {
  let n = 0, any = 0;
  for (let y = f.bb[1]; y <= f.bb[3]; y++) {
    for (let x = f.bb[0]; x <= f.bb[2]; x++) {
      // screen rows flip: the framebuffer's row 0 is the bottom of the picture
      const i = ((Math.round(innerHeight - y - 0.5) * f.dpr) * f.w + Math.round((x + 0.5) * f.dpr)) * 4;
      if (Math.abs(base.buf[i] - f.buf[i]) > 6 || Math.abs(base.buf[i + 1] - f.buf[i + 1]) > 6
        || Math.abs(base.buf[i + 2] - f.buf[i + 2]) > 6) n++;
    }
  }
  for (let i = 0; i < base.buf.length; i += 4) {
    if (Math.abs(base.buf[i] - f.buf[i]) > 6 || Math.abs(base.buf[i + 1] - f.buf[i + 1]) > 6
      || Math.abs(base.buf[i + 2] - f.buf[i + 2]) > 6) any++;
  }
  return { inBox: n, frameTotal: any };
};

const steps = [];
let centre = null;
const run = async (label, set) => {
  if (set) { w.set(set[0], set[1]); await settle(600); }
  await settle(300);
  const on = grab();
  if (!centre) {
    const cx = Math.round((use.bb[0] + use.bb[2]) / 2), cy = Math.round((use.bb[1] + use.bb[3]) / 2);
    const gx = Math.round((cx + 0.5) * on.dpr), gy = Math.round((innerHeight - cy - 0.5) * on.dpr);
    const i = (gy * on.w + gx) * 4;
    centre = { at: [cx, cy], rgba: [on.buf[i], on.buf[i + 1], on.buf[i + 2], on.buf[i + 3]] };
  }
  w.set('bodies', 0);
  await settle(600);
  const base = grab();
  w.set('bodies', 1);
  await settle(600);
  steps.push({ label, boxPx: (use.bb[2] - use.bb[0] + 1) * (use.bb[3] - use.bb[1] + 1), ...paint(base, { ...on, bb: use.bb }) });
};

await run('default (walls obey, markers on)');
await run('bodies through the world', ['bodythrough', 1]);
await run('walls again, markers hidden', ['timetiles', 0]);
await run('markers back', ['timetiles', 1]);
await run('shell far layer off', ['shellon', 0]);
await run('shell back on', ['shellon', 1]);
await run('bodies through + no markers', ['bodythrough', 1]);

console.log(JSON.stringify({
  body: [b.x, b.y, b.z], player: b.player, seat: b.seat, down: b.down,
  framing: { dx: use.dx, dz: use.dz, pitch: use.pitch, box: use.bb, owner: use.at.owner,
    bodyDist: use.at.bodyDist, markerDist: use.at.markerDist, worldDist: use.at.worldDist, floor: use.at.floor },
  framingsTried: fr.map((f) => ({ dx: f.dx, dz: f.dz, pitch: f.pitch, owner: f.at.owner,
    bodyDist: f.at.bodyDist, markerDist: f.at.markerDist, worldDist: f.at.worldDist })),
  settings: { through: w.ghosts().through, look: w.time().look, tiles: w.time().tiles,
    url: location.search },
  colourAtBoxCentre: centre,
  steps,
  note: w.ghostNote(),
}, null, 1));
