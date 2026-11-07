// What arming the time machine actually shows, sampled from the first frame the timeline exists.
// Run twice: with no parameter, and with `?timeplay=0` (a stated choice). Second 0 of this log holds
// nothing for the first 8.5 hours, so "start at the beginning" used to mean "start at an empty map".
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bootWait = 0;
while (!window.__world && bootWait < 20000) { await sleep(25); bootWait += 25; }
const w = window.__world;
const out = { bootWaitMs: bootWait,
  askedPaused: new URLSearchParams(location.search).get('timeplay'),
  playTouched: w.settings.playTouched, speed: w.settings.timeSpeed };
const ramp = [];
const t0 = performance.now();
let armed = null;
while (performance.now() - t0 < 25000) {
  const s = [Math.round(performance.now() - t0), w.TLAYER.tl ? 1 : 0, w.TLAYER.quads, w.TLAYER.drawn,
    w.settings.timePlay];
  ramp.push(s);
  if (!armed && s[2] > 0) armed = s;
  if (armed && s[3] === s[2] && performance.now() - t0 - armed[0] > 500) break;
  await sleep(100);
}
const end = { ...w.time() };
out.armed = armed;                 // [ms, tl?, items, drawn, playing] the first instant the filter exists
out.armsPlaying = armed ? (armed[4] === 1) : null;
out.drawnAtArm = armed ? armed[3] : null;
out.end = { ms: Math.round(performance.now() - t0), drawn: end.drawn, items: end.quads,
  playing: end.playing, cur: end.cur, atDay: end.cur >= 0 ? 1 : 0 };
out.ramp = ramp.filter((_, i) => i % 6 === 0);
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
