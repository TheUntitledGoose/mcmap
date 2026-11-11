// M15.3 acceptance: do the players actually stand in the page, and does a click answer the body?
//
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=-59,72,-130&dist=28&time=1&timecls=0&debug=1" \
//     --wait 14000 --eval-file build/q_m15bodies.js > build/m15_bodies.txt
//   node build/m15_parse.cjs build/m15_bodies.txt atBoot,atPeak,bodies,wideFraming,closeTried,closeFraming,throughFraming,emptyDecade,offSwitch
//
// What it asserts, in the order a person would check it:
//   1. the presence pass ran over the SHIPPED timeline (v4), and its numbers match build/dbg-presence.mjs
//      (56,949 hand rows, 393 visits, a body supported somewhere at 0.26% of the log's seconds);
//   2. at the second the log supports the most people at once, that many bodies exist, each with feet from
//      the page's own voxels ('ground') or a named hedge ('float' / 'unknown');
//   3. in a WIDE framing a nearer change marker keeps the pixel it owns - a body does not steal clicks
//      through the world;
//   4. in a CLOSE framing, with a clear line of sight to a person, the click answers THAT person: a card
//      naming them, the action that puts them there, and their history near the playhead. Candidate
//      framings are judged by the three rays a click answers (body / change marker / world) rather than by
//      the voxel column alone, because the replay paints change markers through the air and a marker is
//      not part of the collision read; and where no framing lets a person keep their pixel, the probe
//      moves to `bodyThrough`, the whole-world finder, and asks there.
//   5. a playhead in the empty decades draws nobody and says why, per player, with dates;
//   6. `bodies=0` leaves nothing in the scene at all.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);

const out = { bootError: w.state.bootError ?? null };
const g0 = w.ghosts();
out.atBoot = { on: g0.on, timeOn: g0.timeOn, err: g0.err, standing: g0.standing, seats: g0.seats };
out.presence = g0.presence ? {
  gap: g0.presence.gap, handRows: g0.presence.handRows, visits: g0.presence.visits,
  first: g0.presence.first, last: g0.presence.last, spanDays: +(g0.presence.spanSec / 86400).toFixed(2),
  logDays: +(g0.presence.logSec / 86400).toFixed(1),
  players: g0.presence.players.map((p) => `${p.name}:${p.rows}/${p.visits}`),
} : null;
out.occupancy = g0.occ ? {
  visits: g0.occ.visits, sec: g0.occ.sec, pct: +g0.occ.pct.toFixed(3),
  peak: g0.occ.peak, peakAt: g0.occ.peakAt,
} : null;
out.buildMs = g0.buildMs;

// Park where the log supports the most people at once, and let the chunks under those people arrive: a
// seat answered before the column loads is 'unknown', and it is supposed to become 'ground' on its own.
w.setTimePlay(0);
const peak = g0.occ ? g0.occ.peakAt : (g0.presence ? g0.presence.first : 0);
w.ghostApply(peak);
await settle(2500);
const g1 = w.ghosts();
out.atPeak = {
  peak, at: g1.sec, standing: g1.standing, wantPeak: g0.occ ? g0.occ.peak : null,
  seats: g1.seats, verts: g1.verts, drawn: g1.drawn, routes: g1.routes,
  tagsShown: g1.tagsShown, tagsSmall: g1.tagsSmall, through: g1.through,
  // how many of those stand under the open sky: the number that explains a name tag over a hillside
  under: g1.under, deepestY: g1.deepestY, deepestDown: g1.deepestDown,
  syncMs: g1.syncMs, cutMs: g1.cutMs, buildMs: g1.buildMs, syncs: g1.syncs, cuts: g1.cuts,
};
out.tags = [...document.querySelectorAll('.gtag')].map((el) => el.textContent.replace(/\s+/g, ' '));
out.bodies = g1.bodies.map((b) => (b.absent
  ? { player: b.player, absent: b.absent, age: b.age, acted: b.acted }
  : { p: b.player, x: b.x, y: b.y, z: b.z, seat: b.seat, above: b.above, down: b.down, age: b.age,
    block: b.block, screen: w.project(b.x + 0.5, b.y + 0.9, b.z + 0.5) }));
out.why = g1.why;
out.note = w.ghostNote();

// 3. the WIDE framing: a change marker that stands in FRONT of a person still answers its own pixels, and
// rock answers where it is nearest. Whatever owns the pixel, the answer is recorded as a number.
const aimAt = async (b) => {
  const scr = w.project(b.x + 0.5, b.y + 0.9, b.z + 0.5);
  const px = Math.round(scr[0]), py = Math.round(scr[1]);
  if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) return { player: b.player, offScreen: [px, py] };
  const near = w.ghostHit(px, py);
  const own = w.ownerAt(px, py);
  // The outline must agree with the click: `from: 'body'` on a pixel the click answers with a person is
  // the same rule reached by the other path, at a cost the frame loop can afford.
  const hv = w.hoverAt(px, py);
  const ask = await w.askAt(px, py);
  const g = w.ghosts();
  return {
    player: b.player, px, py, body: [b.x, b.y, b.z], seat: b.seat,
    rule: own.rule, owner: own.owner, bodyDist: own.bodyDist,
    markerDist: own.markerDist, worldDist: own.worldDist,
    hover: hv ? { from: hv.from, body: hv.body, at: hv.at, ms: hv.ms, visible: hv.visible,
      why: String(hv.why ?? '').slice(0, 96) } : null,
    hitPlayer: near ? near.player : null, hitWhy: g.hitWhy, hitMs: g.hitMs,
    askWhy: w.ledger().askWhy,
    cardHead: (document.querySelector('.lcard-head')?.textContent ?? '').replace('\u00d7', '').trim().slice(0, 130),
    cardSub: (document.querySelector('.lcard-sub')?.textContent ?? '').slice(0, 90),
    cardLines: document.querySelectorAll('.lcard-line').length,
    askRows: ask ? ask.rows?.length ?? null : null,
  };
};
out.wideFraming = [];
for (const b of g1.bodies) if (!b.absent) out.wideFraming.push(await aimAt(b));

// 4. the CLOSE framing: stand in front of one person and click them. The camera moves to the body rather
// than the other way round, because that is what a person does when they want to look at somebody.
//
// A candidate framing is only worth clicking if the person owns their own pixel, so candidates are judged
// by the same three rays a click answers - body, change marker, world - and NOT by the voxel column: a
// change marker is not in the collision read, and around a replayed house the air is full of them. Every
// candidate is recorded, so "the body did not win anywhere" would be a number, not a screenshot.
const pixelOwner = (b) => {
  const scr = w.project(b.x + 0.5, b.y + 0.9, b.z + 0.5);
  const px = Math.round(scr[0]), py = Math.round(scr[1]);
  if (px < 8 || py < 8 || px > innerWidth - 8 || py > innerHeight - 8) return { off: [px, py] };
  if (!w.ghostHit(px, py)) return { noBody: true, px, py };
  // The page's own answer, not a re-derivation: `ownerAt` runs the same three rays a click runs and the
  // same rule the click applies.
  const o = w.ownerAt(px, py);
  // `nearest` is what `?bodypick=0` would answer, derived from the same three ray distances the page just
  // measured. Comparing the two in one pass is the A/B, without paying a second raycast for it.
  const ranked = [['body', o.bodyDist], ['marker', o.markerDist], ['world', o.worldDist]]
    .filter((q) => q[1] !== null).sort((a, b) => a[1] - b[1]);
  return { px, py, rule: o.rule, owner: o.owner, nearest: ranked[0]?.[0] ?? 'nothing', bodyDist: o.bodyDist,
    markerDist: o.markerDist, worldDist: o.worldDist };
};
const standing = g1.bodies.filter((q) => !q.absent && q.seat === 'ground');
const cands = [];
for (const b of standing) {
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    for (const d of [5, 9, 16]) cands.push({ b, dx, dz, d });
  }
}
let chosen = null;
const tried = [];
for (const c of cands.slice(0, 48)) {
  const n = Math.hypot(c.dx, c.dz);
  w.go(c.b.x + 0.5, c.b.y + 1.1, c.b.z + 0.5);
  w.orbit(Math.atan2(-c.dx / n, -c.dz / n), 0, c.d);
  w.sync();
  await settle(220);
  w.ghostApply(peak);
  const o = pixelOwner(c.b);
  tried.push({ player: c.b.player, d: c.d, dx: c.dx, dz: c.dz, ...o });
  if (o.owner === 'body') { chosen = c; break; }
}
out.closeTried = { n: tried.length, chosen: !!chosen, rule: w.ghosts().pickRule,
  owners: tried.reduce((a, t) => (a[t.owner ?? (t.noBody ? 'noBody' : 'off')] = (a[t.owner ?? (t.noBody ? 'noBody' : 'off')] ?? 0) + 1, a), {}),
  nearestOwners: tried.reduce((a, t) => (a[t.nearest ?? (t.noBody ? 'noBody' : 'off')] = (a[t.nearest ?? (t.noBody ? 'noBody' : 'off')] ?? 0) + 1, a), {}),
  first: tried.slice(0, 6) };
if (chosen) {
  await settle(1400);
  w.ghostApply(peak);
  await settle(700);
  const g2 = w.ghosts();
  out.closeFraming = {
    target: [chosen.b.x, chosen.b.y, chosen.b.z], cam: w.camPos(), dist: chosen.d,
    dir: [chosen.dx, chosen.dz], owner: pixelOwner(chosen.b),
    standing: g2.standing, seats: g2.seats, verts: g2.verts, tagsShown: g2.tagsShown,
    tagText: [...document.querySelectorAll('.gtag')].map((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 90)),
    aim: await aimAt(chosen.b),
    note: w.ghostNote(),
  };
}

// 4b. `?bodythrough=1` says "show me people through the world": bodies win their pixels outright, so in a
// framing where rock or markers stand in front of every person there is still a way to ask one.
w.settings.bodyThrough = 1;
w.ghostApply(peak);
await settle(900);
out.throughFraming = { through: w.ghosts().through, aim: [] };
for (const b of standing) out.throughFraming.aim.push(await aimAt(b));
w.settings.bodyThrough = 0;
w.ghostApply(peak);
await settle(600);

// 5. the empty half of the log: nobody, with a reason each.
w.ghostApply((g0.presence ? g0.presence.last : 0) + 86400 * 30);
await settle(900);
const g3 = w.ghosts();
out.emptyDecade = { standing: g3.standing, absent: g3.absent, why: g3.why, verts: g3.verts, drawn: g3.drawn };
out.emptyNote = w.ghostNote();

// 6. the switch: bodies off must leave nothing in the scene, and it must do it through the frame hook
// (this sets S.bodies directly rather than calling the panel's setter, which is what a remembered
// setting or a URL parameter does).
w.settings.bodies = 0;
await settle(900);
const g4 = w.ghosts();
out.offSwitch = { standing: g4.standing, verts: g4.verts, drawn: g4.drawn, routes: g4.routes, tagsShown: g4.tagsShown };
console.log(JSON.stringify(out, null, 1));
