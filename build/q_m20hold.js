// Ticking the time machine OFF and back ON must not move the moment.
//
// A fresh arm deliberately starts at the first logged change and plays (second 0 is empty ground in this
// save). That decision belongs to the first arm of a filter. It used to run on every un/tick of the
// checkbox, so a viewer who switched the overlay off to look at the bare world came back to a different
// second - and a screenshot or a click then answered a moment they never asked for.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
const params = new URLSearchParams(location.search);
const seek = Number(params.get('seek') || 0);
for (let i = 0; i < 60 && !(w.time().tl && w.time().quads > 0); i++) await settle(250);
w.setTimePlay(0);
w.seekSec(seek);
await settle(1200);

const read = () => { const t = w.time(); return { sec: t.sec, drawn: t.drawn, rows: t.rows, play: t.playing }; };
const out = { framing: location.search, tries: [] };
for (let round = 0; round < 2; round++) {
  const before = read();
  w.set('time', 0); await settle(700);
  const off = { mesh: !!w.time().quads };
  w.set('time', 1); await settle(1500);
  w.setTimePlay(0);
  const after = read();
  out.tries.push({ before, off, after, held: after.sec === before.sec && after.drawn === before.drawn });
  // and a scrub position, set differently each round, must survive too
  w.seekSec(Math.round(seek * (round ? 0.6 : 0.25)));
  await settle(600);
}
// Does the play/pause state come back? An un/tick of a PAUSED machine must not start it running.
w.setTimePlay(0); const p0 = read();
w.set('time', 0); await settle(500); w.set('time', 1); await settle(1200);
out.pauseHeld = { before: p0.play, after: read().play };
// A filter change is a different question, and it is allowed to answer with a different moment.
const cls0 = read();
w.set('timecls', 2); await settle(2500);
out.filterChange = { before: cls0, after: read() };
console.log('HOLD ' + JSON.stringify(out));
