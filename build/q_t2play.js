// Press play and watch the two counters the panel prints: the row cursor and the drawn count. If the play
// head reaches the end of the filter and the panel still says "0 / 90,045", then what the user sees as a
// date is not what the world is drawing.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const out = { settings: { time: w.state.time, timeCls: w.state.timeCls, who: w.ledger().who, speed: w.state.timeSpeed } };
for (let i = 0; i < 150; i++) { await raf(); w.tick(1); }
out.before = { cur: Math.round(w.time().cur), drawn: w.time().drawn, sec: w.time().sec };
w.set('timePlay', 1);
out.walk = [];
for (let i = 0; i < 12; i++) {
  for (let k = 0; k < 40; k++) { await raf(); w.tick(1); }
  const t = w.time();
  out.walk.push({ cur: Math.round(t.cur), drawn: t.drawn, sec: t.sec, playing: t.playing });
  if (!t.playing) break;
}
const t = w.time();
out.after = { cur: Math.round(t.cur), drawn: t.drawn, quads: t.quads, sec: t.sec, playing: t.playing };
out.row = [...document.querySelectorAll('.panel-row')].filter((r) => /time machine|playhead/i.test(r.textContent))
  .map((r) => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 90));
return out;
