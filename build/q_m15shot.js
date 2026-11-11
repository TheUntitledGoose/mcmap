// A picture of the people, framed by the page's own rays. Two moments are worth a picture:
//
//   the second the log supports the most people at once (default)
//   a second where one of them stood at the open sky, from build/dbg-surfaceghosts.mjs, by URL:
//     &gsec=112480&gplayer=4      (playerE on an acacia log at -88,66,-17, 2024-06-02 00:12:50)
//
//   node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=-59,72,-130&dist=28&time=1&timecls=0" \
//     --wait 14000 --eval-file build/q_m15shot.js --shot 1000x640 --out build/shot_m15_bodies.png
//   and with &gsec=112480&gplayer=4 for the outdoor one, or &caves=1 for the mine, or &bodythrough=1
//
// A framing is accepted only when the page's OWN rays agree that the person is what you see:
//   - the body answers the pixel at its own middle (default `?bodypick=1` still obeys walls, so this means
//     nothing is drawn in front of them),
//   - and the ray aimed at the pixel above the head hits nothing, or hits rock at least 3 blocks higher than
//     whatever is at the body: a person under a mine roof is honest but makes a picture of the inside of a hole.
// The chosen framing is then RE-VERIFIED after the chunks around the new eye position arrive: the first
// version chose a framing that was clear only until the detail chunk loaded, and the picture showed rock
// with a name tag floating over it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);

const want = new URLSearchParams(location.search).get('want') || 'peak';
const gsec = new URLSearchParams(location.search).get('gsec');
const gplayer = new URLSearchParams(location.search).get('gplayer');
// `&gat=x,y,z` names the body to frame (nearest to it). Without it the search walks the standing list in
// timeline order and can happily fly 1,400 blocks to the one person with a known floor, which is how the
// first party picture ended up as a portrait of a mine at -1376,-30,-1469.
const gat = (new URLSearchParams(location.search).get('gat') || '').split(',').filter((s) => s !== '').map(Number);
const g0 = w.ghosts();
w.setTimePlay(0);

// The settings panel is hidden for the picture only: a DOM style, not a render setting.
const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';

const scr = (b, dy) => { const p = w.project(b.x + 0.5, b.y + dy, b.z + 0.5); return [Math.round(p[0]), Math.round(p[1])]; };
const inFrame = ([px, py]) => px > 220 && py > 150 && px < innerWidth - 220 && py < innerHeight - 150;

/**
 * What the page itself says about the current framing: who owns the body's pixel, and what is over their
 * head. The sky sample is only required for a body that is UNDER the open sky (`b.down > 3`, the same number
 * the name tag shows): for a person standing outside, the roof test would only reject valid short framings
 * where the sky sample has left the picture.
 */
const probeFrame = (b) => {
  const mid = scr(b, 0.9);
  if (!inFrame(mid)) return null;
  const at = w.ownerAt(mid[0], mid[1]);
  const up = scr(b, 6.5);
  const roof = b.down != null && b.down > 3;      // a mined body needs a roof test; an outdoor one does not
  if (!inFrame(up)) return roof ? null : { mid, at, above: { owner: 'off-frame' }, clear: null };
  const above = w.ownerAt(up[0], up[1]);
  // How much higher the first thing drawn over the head is than the thing at the body. `nothing` is open sky.
  const clear = above.owner === 'nothing' ? 99 : +(((above.worldDist ?? 0) - (at.bodyDist ?? 0))).toFixed(2);
  return { mid, at, above, clear };
};

const park = async (b, dx, dz, d, pitch, sec) => {
  const n = Math.hypot(dx, dz);
  w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5);
  w.orbit(Math.atan2(-dx / n, -dz / n), pitch, d);
  w.sync();
  await settle(300);
  w.ghostApply(sec);
  const f = probeFrame(b);
  return f ? { b, dx, dz, d, pitch, sec, ...f } : null;
};

// A `ownerAt` pass pays the marker ray (~220 ms), so the search stays small: the first framing that works
// is good enough for a picture. The camera has to stay high enough that the sky sample over the head is
// still on screen, which is what the steeper pitches buy.
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const DIST = [10, 18, 30, 50];
const PITCH = [-0.35, -0.7, -1.1];
const tried = [];
let best = null;

const searchOnce = async (list, sec) => {
  for (const b of list) {
    for (const [dx, dz] of DIRS) {
      for (const d of DIST) {
        for (const pitch of PITCH) {
          const p = await park(b, dx, dz, d, pitch, sec);
          if (!p) continue;
          if (p.at.owner === 'body' && (p.clear == null || p.clear >= 3)) return p;
          tried.push({ at: [b.x, b.y, b.z], d, pitch, owner: p.at.owner, clear: p.clear,
            bodyDist: p.at.bodyDist, worldDist: p.at.worldDist });
          // an eye inside the skin of a hill can never see a person: skip the rest of that distance
          if ((p.at.worldDist ?? 99) < 1.5) break;
          if (!best || p.clear > best.clear) best = p;
        }
      }
    }
  }
  return null;
};

/** The moment to picture: a measured outdoor second from the URL, or the busiest second of the log. */
const moment = gsec ? { sec: +gsec, player: gplayer == null ? null : +gplayer } : null;
const sec = moment ? moment.sec : (g0.occ ? g0.occ.peakAt : g0.presence.first);
w.ghostApply(sec);
// The named body's chunk has to arrive before its floor is knowable, or its seat answers 'unknown' and the
// search skips it.
await settle(gat.length === 3 ? 4500 : 2500);

// A framing that passes the rays can stop passing them: the chunks around the new eye position arrive
// afterwards, and then the rock in front of the person is real. So frame, settle, re-check, and if the
// picture moved, search again from the now-real world; the last attempt falls back to the clearest framing
// found so far and says so.
let shot = null;
for (let attempt = 0; attempt < 3 && !shot; attempt++) {
  const near = gat.length === 3
    ? (b) => Math.max(Math.abs(b.x - gat[0]), Math.abs(b.y - gat[1]), Math.abs(b.z - gat[2]))
    : () => 0;
  const standing = w.ghosts().bodies
    .filter((b) => !b.absent && b.seat === 'ground'
      && (!moment || moment.player == null || b.player === moment.player)
      // a body 100 blocks under the open sky makes a picture of the inside of a hole, so it goes last
      && (b.down == null || b.down <= 6))
    .sort((a, b) => (a.down ?? 0) - (b.down ?? 0) || near(a) - near(b))
    .concat(w.ghosts().bodies.filter((b) => !b.absent && b.seat === 'ground' && b.down > 6));
  const found = await searchOnce(standing, sec);
  const cand = found ?? (attempt === 2 ? best : null);
  if (!cand) break;
  // `best` is the clearest framing seen so far, but the search walked on past it: put the camera back.
  if (!found) await park(cand.b, cand.dx, cand.dz, cand.d, cand.pitch, sec);
  await settle(1800);
  w.ghostApply(sec);
  await settle(1200);
  const f = probeFrame(cand.b);
  if (f && f.at.owner === 'body') {
    shot = { ...cand, ...f, strict: !!found, bodyDist: f.at.bodyDist, worldDist: f.at.worldDist,
      aboveOwner: f.above.owner };
  } else {
    tried.push({ at: [cand.b.x, cand.b.y, cand.b.z], d: cand.d, owner: f ? f.at.owner : 'off',
      why: 'the picture changed once the ground under the new eye position arrived' });
  }
}

const g = w.ghosts();
console.log(JSON.stringify({
  want, moment, panelHidden: !panel || panel.style.display === 'none',
  shot: shot && { body: [shot.b.x, shot.b.y, shot.b.z], player: shot.b.player, dist: shot.d,
    dir: [shot.dx, shot.dz], px: shot.mid[0], py: shot.mid[1], strict: shot.strict,
    owner: shot.owner, bodyDist: shot.bodyDist, worldDist: shot.worldDist,
    aboveHead: shot.aboveOwner, clearAboveHead: shot.clear },
  rejected: tried.slice(0, 12), rejectedCount: tried.length,
  clearestRejected: best && { at: [best.b.x, best.b.y, best.b.z], d: best.d, pitch: best.pitch,
    owner: best.at.owner, clear: best.clear, bodyDist: best.at.bodyDist, worldDist: best.at.worldDist },
  standing: g.standing, seats: g.seats, under: g.under, deepestY: g.deepestY, deepestDown: g.deepestDown,
  bodies: g.bodies.map((b) => (b.absent ? { player: b.player, absent: b.absent }
    : { player: b.player, at: [b.x, b.y, b.z], seat: b.seat, down: b.down })),
  verts: g.verts, drawn: g.drawn, routes: g.routes,
  tagsShown: g.tagsShown, tagsSmall: g.tagsSmall, through: g.through,
  tags: [...document.querySelectorAll('.gtag')].map((el) => el.textContent.replace(/\s+/g, ' ')),
  note: w.ghostNote(),
}, null, 1));
