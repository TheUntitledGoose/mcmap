// Does the highlight answer the SECOND being drawn, or today?
//
// The voxel this probe stands on was broken at second 92,280 (the log names `regions_unexplored:mauve_log`,
// the block that left) and then re-skinned 50-70k seconds later: white_concrete, white_concrete again,
// polished_diorite. So at the playhead this probe seeks to (112,612 s) the honest answer is the mauve_log
// break, and today's world holds polished_diorite. A layer that keeps only the NEWEST claim of a voxel has
// no marker at or before this second at all, the click falls through to the present-day terrain, and the
// person sees today's block named under their cursor - which is the complaint.
//
// URL knobs this probe reads: &seek=<ISO or seconds> (default 112612) and &vox=x,y,z.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const q = new URLSearchParams(location.search);
const out = {};
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
for (let i = 0; i < 6; i++) await settle(300);

const t = w.time();
out.time = {
  quads: t.quads, drawn: t.drawn, look: t.look, sec: t.sec, playhead: t.playheadSec ?? null,
  culled: t.culledFaces, inside: t.fullyInside, faceCull: t.faceCull, deduped: t.dedupedClaims,
  dedupeMode: t.dedupeMode, stacked: t.stacked, maxStack: t.maxStack, mb: t.markerGeoMb,
  depthTest: t.depthTest, polyOffset: t.polyOffset, fact: t.fact || t.err || '',
};

// Stand the playhead on the second the complaint was made at. A fresh arm PLAYS, so the playhead would run
// on past the seek while this probe waits - pause first, or the answer belongs to a different second.
w.setTimePlay(0);
const want = q.get('seek');
const sec = /^\d+$/.test(want || '') ? +want : Math.round((Date.parse(want) - w.time().base * 1000) / 1000);
out.seeked = w.seekSec(sec);
await settle(600);
// A fresh arm re-plays inside timeRebuild, which can land AFTER this probe's first wait. Pause again, right
// before asking anything, or the answer belongs to whichever second the playhead ran on to.
w.setTimePlay(0);
out.playhead = w.time().sec;
out.drawnAfterSeek = w.time().drawn;

const vox = (q.get('vox') || '-40,64,-122').split(',').map(Number);
const [vx, vy, vz] = vox;
// What does the time layer itself say stands at this voxel, at this second? Rows, not names: the Node side
// (build/dbg-straddle.mjs) says which row is which block, so a browser answer cannot talk itself into agree
// with itself.
out.standsAt = w.timeStandAt(vx, vy, vz) ?? null;

// What is the marker over that voxel, by the page's own ray? Project the voxel centre, then walk a small
// screen neighbourhood: a marker exactly one block wide can sit between two pixels, and the page's own ray
// is the only thing allowed to say which marker owns the pixel.
const p = w.project(vx + 0.5, vy + 0.5, vz + 0.5);
// project() already answers in screen pixels (and a z the probe can check is in front of the camera).
const sx = p[0], sy = p[1];
out.projected = [+sx.toFixed(1), +sy.toFixed(1), p[2]];
let best = null, owners = {}, tries = 0;
// A marker raycast is ~200 ms on a whole-dimension buffer, so this scan is deliberately tiny: 25 points, and
// it stops the moment the voxel in question answers.
for (let dy = -8; dy <= 8 && !best; dy += 4) {
  for (let dx = -8; dx <= 8; dx += 4) {
    const px = Math.round(sx + dx), py = Math.round(sy + dy);
    if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
    tries++;
    const mbx = w.timeMarkerBox ? w.timeMarkerBox(px, py) : null;
    if (mbx && mbx.voxel && mbx.voxel[0] === vx && mbx.voxel[1] === vy && mbx.voxel[2] === vz) {
      best = { px, py, box: mbx, owner: w.ownerAt(px, py), world: w.pickWorld(px, py) };
      break;
    }
    if (mbx && mbx.voxel) owners[mbx.voxel.join(',')] = (owners[mbx.voxel.join(',')] || 0) + 1;
  }
}
out.scan = { tries, near: Object.keys(owners).length, owners: Object.entries(owners).slice(0, 4) };
out.markerBox = best ? best.box : null;
out.owner = best ? best.owner : null;
out.at = best ? [best.px, best.py] : null;
out.world = best ? (({ block, state, drawn, dist }) => ({ block, state, drawn, dist }))(best.world || {}) : null;

// The whole answer in one line, for the log.
const mb = out.markerBox || {};
console.log('STRADDLE ' + JSON.stringify({
  vox, sec, playhead: out.playhead, playheadAfterScan: w.time().sec, drawn: out.drawnAfterSeek,
  at: out.at, projected: out.projected,
  scan: out.scan,
  stands: out.standsAt && {
    row: out.standsAt.row, sec: out.standsAt.sec, cls: out.standsAt.cls, stands: out.standsAt.stands,
    before: out.standsAt.before, n: out.standsAt.n, later: out.standsAt.later,
    starts: out.standsAt.starts && out.standsAt.starts.row,
  },
  marker: mb.voxel && { row: mb.row, sec: mb.sec, voxel: mb.voxel, name: mb.name, action: mb.action, quads: mb.quads, overVoxel: mb.overVoxel, repeat: mb.repeat, drawn: mb.drawn },
  ownerOwner: out.owner && out.owner.owner, worldBlock: out.world && out.world.block, worldState: out.world && out.world.state,
  time: out.time,
}));
