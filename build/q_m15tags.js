// build/q_m15tags.js -- a name over a person has to be READABLE: placed, inside the frame, and never left
// sitting unpainted at the corner of the screen. For each of several moments the probe frames the shallowest
// standing body, then measures every label's DOM box, whether it was placed at all, how many the page hid
// and why, and whether a rebuild ever leaves a label at the box origin. One page load.
//
//   node tools/browser-probe.mjs "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0" \
//     --wait 14000 --eval-file build/q_m15tags.js --out build/shot_tags.png
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const panel = document.querySelector('.panel');
if (panel) panel.style.display = 'none';
w.setTimePlay(0);

const labels = () => [...document.querySelectorAll('#gtags .gtag')].map((e) => {
  const r = e.getBoundingClientRect();
  return { text: e.textContent.replace(/\s+/g, ' ').slice(0, 56), placed: (e.style.transform || '') !== '',
    display: e.style.display === 'none' ? 'none' : 'shown',
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    inFrame: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    empty: r.width < 1 || r.height < 1 };
});

function aim(b) {                       // put the body in the middle of the picture and wait for the look
  w.go(b.x + 0.5, b.y + 1.0, b.z + 0.5);
  w.orbit(Math.PI / 4, -0.3, 18);
  w.sync();
}

const out = { viewport: [innerWidth, innerHeight], moments: [], unpaintedAfterBuild: 0, frameErrors: 0 };
const occ = w.ghosts().occ;
// A spread of moments: the busiest second the log offers, then samples across the whole filtered window, so
// one lucky second cannot stand in for "the labels work".
const secs = [];
if (occ?.peakAt != null) for (const d of [0, -60, 60, -300, 300, -1800, 1800]) secs.push(occ.peakAt + d);
// A URL that names a second asks about THAT moment: the party and the mine are different pictures, and the
// corner label the screenshot showed was at a framing chosen by hand.
const g0 = +(new URLSearchParams(location.search).get('gsec') ?? NaN);
if (Number.isFinite(g0)) { secs.length = 0; for (const d of [0, -30, 30, -120, 120]) secs.push(g0 + d); }
for (const sec of secs) {
  w.ghostApply(sec);
  await settle(1600);
  // A label that was just rebuilt must not paint at the box origin while waiting for the next frame.
  const fresh = labels().filter((l) => l.display === 'shown' && !l.placed);
  if (fresh.length) out.unpaintedAfterBuild++;
  const standing = w.ghosts().bodies.filter((b) => !b.absent && b.seat === 'ground' && (b.down == null || b.down <= 6));
  if (!standing.length) { out.moments.push({ sec, standing: 0, g: w.ghosts() }); continue; }
  const b = standing[0];
  aim(b);
  await settle(1800);
  const p = w.project(b.x + 0.5, b.y + 1.8, b.z + 0.5);
  const ls = labels();
  const g = w.ghosts();
  // Now slide the VIEW so the same person sits near an edge: a label whose person is 10 px in from the left
  // has 300 px of sentence hanging off the picture, and the fix has to be measured, not assumed. The body
  // keeps its place; only the words move.
  w.go(b.x + 8.5, b.y + 1.0, b.z + 0.5);
  w.sync();
  await settle(1200);
  const pe = w.project(b.x + 0.5, b.y + 1.8, b.z + 0.5);
  const le = labels();
  const ge = w.ghosts();
  const edge = {
    bodyPx: [Math.round(pe[0]), Math.round(pe[1])], shown: ge.tagsShown, off: ge.tagOff,
    clamped: ge.tagClamped, placed: le.filter((l) => l.placed).length,
    outOfFrame: le.filter((l) => l.display === 'shown' && !l.inFrame).map((l) => l.box),
    atOrigin: le.filter((l) => l.display === 'shown' && l.box[1] < 6 && l.box[0] < 6).map((l) => l.text),
  };
  aim(b);
  await settle(900);
  out.moments.push({
    sec, body: [b.x, b.y, b.z], seat: b.seat, down: b.down ?? null, bodyPx: [Math.round(p[0]), Math.round(p[1])],
    standing: g.standing, labels: ls.length, shown: g.tagsShown, small: g.tagsSmall, off: g.tagOff,
    clamped: g.tagClamped, placed: ls.filter((l) => l.placed).length,
    outOfFrame: ls.filter((l) => l.display === 'shown' && !l.inFrame).map((l) => l.box),
    nearBody: ls.filter((l) => l.display === 'shown' && Math.abs(l.box[0] + (l.box[2] - l.box[0]) / 2 - p[0]) < 220),
    atOrigin: ls.filter((l) => l.display === 'shown' && l.box[1] < 6 && l.box[0] < 6).map((l) => l.text),
    edge,
    tags: ls.filter((l) => l.display === 'shown'),
  });
}
out.frameErrors = w.state.frameErrors ?? 0;
out.totals = {
  moments: out.moments.length,
  labelsPlaced: out.moments.reduce((a, m) => a + (m.placed ?? 0), 0),
  slidOnEdge: Math.max(0, ...out.moments.map((m) => m.edge?.clamped ?? 0)),
  anyOutOfFrame: out.moments.filter((m) => (m.outOfFrame?.length ?? 0) || (m.edge?.outOfFrame?.length ?? 0)).length,
  anyAtOrigin: out.moments.filter((m) => (m.atOrigin?.length ?? 0) || (m.edge?.atOrigin?.length ?? 0)).length,
};
out.note = w.ghostNote();
console.log(JSON.stringify(out, null, 1));
