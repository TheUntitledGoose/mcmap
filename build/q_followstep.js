// Can the page follow a person, and step the playhead one logged change at a time - WITH THE KEYS?
//
// One page load: find the busiest second the log offers, put the camera on one of the people standing
// there, then walk the playhead row by row, first with the same call the `<` / `>` keys make and then with
// the keys themselves (a real KeyboardEvent, because a handler that only works when a probe calls a
// function is a feature nobody can press). For each stop it records where the camera target got to, how far
// that is from the body the evidence puts on the map, and what the page said out loud.
//
// The interesting numbers:
//   lag      camera target to body. A small move should close to ~0; a big one eases, so a mid-ease value
//            of a few blocks is correct, and a value that never closes is not.
//   moved    how far the target moved since the last stop. At a moment where the followed person has NO
//            body this must be 0: the camera holds rather than glide somewhere the log never saw them.
//   keyStep  the playhead row before/after each key event, so `<` / `>` / `,` / `.` are each proven.
//
//   node tools/browser-probe.mjs \
//     "http://127.0.0.1:8765/?goto=102,119,49&dist=20&time=1&timecls=0&caves=1" \
//     --wait 14000 --eval-file build/q_followstep.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const key = (init) => dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
const msg = () => document.getElementById('msg')?.textContent ?? '';

w.setTimePlay(0);
const sec = w.ghosts().occ?.peakAt ?? null;
if (sec != null) { w.ghostApply(sec); await settle(2000); }
const standing = w.ghosts().bodies.filter((b) => !b.absent);
if (!standing.length) { console.log(JSON.stringify({ err: 'nobody stands at this second', ghosts: w.ghosts() })); return; }
const pres = w.ghosts().presence ?? { players: [] };
const target = standing.find((b) => b.seat === 'ground') ?? standing[0];
const who = (pres.players.find((p) => p.player === target.player) ?? {}).name ?? null;

// The panel row / B key path: follow by name, which also filters the overlay and the replay to them.
const started = w.follow(who ?? target.player + 1);
await settle(1500);
const afterStart = w.followState();
const saidStart = msg();

const far = (a, b) => (a && b ? +Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(2) : null);
const rows = [];
let prevTarget = afterStart.target;
for (let k = 0; k < 14; k++) {
  const at = w.stepRows(k < 7 ? 1 : -1);
  await settle(450);                          // a few frames of easing, not a wait-for-idle
  const f = w.followState();
  rows.push({ at, cur: w.time().cur, playheadSec: w.time().sec, body: f.body, gap: f.gap,
    jumps: f.jumps, target: f.target, moved: far(f.target, prevTarget),
    lag: f.body ? far(f.target, [f.body[0] + 0.5, f.body[1] + 1, f.body[2] + 0.5]) : null,
    why: f.why, said: msg() });
  prevTarget = f.target;
}

// The keys themselves: what a hand on the keyboard does. `<` needs Shift on the usual layout, so the
// physical Comma / Period keys are matched too, and both forms get proven here.
const keys = [];
for (const ev of [{ key: '>', code: 'Period' }, { key: '.', code: 'Period' },
  { key: '<', code: 'Comma' }, { key: ',', code: 'Comma' }]) {
  const before = w.time().cur;
  key(ev);
  await settle(350);
  const f = w.followState();
  keys.push({ ev, before, after: w.time().cur, said: msg(),
    target: f.target, lag: f.body ? far(f.target, [f.body[0] + 0.5, f.body[1] + 1, f.body[2] + 0.5]) : null,
    body: f.body });
}

// The hold: park the playhead where this person has no body, and check the camera does not move.
const beforeHold = w.followState();
w.ghostApply(w.time().span ?? 0);
await settle(1200);
const hold = w.followState();

// Esc gives the camera back.
key({ key: 'Escape', code: 'Escape' });
await settle(600);
const stopped = w.followState();
const t = w.time();
console.log(JSON.stringify({
  second: sec, standing: standing.length, names: (pres.players ?? []).map((n) => n.name),
  wantWho: who, started, saidStart, start: afterStart,
  stepRowsWorked: rows.every((r) => r.at >= 0),
  maxLag: Math.max(...rows.map((r) => r.lag ?? 0)),
  minLag: Math.min(...rows.map((r) => r.lag ?? 1e9)),
  movedAny: rows.filter((r) => r.moved > 0.01).length,
  rows,
  keys,
  keyStepsMoved: keys.map((k) => k.after - k.before),
  hold: { before: beforeHold, after: hold, heldDistance: far(hold.target, beforeHold.target), said: msg() },
  stopped, saidStop: msg(),
  time: { cur: t.cur, drawn: t.drawn, quads: t.quads, who: t.who, cls: t.cls },
  note: w.ghostNote(),
}, null, 1));
