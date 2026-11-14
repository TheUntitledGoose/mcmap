// Find a moment where several people stand, and say where to put the camera to see them.
// The time machine remembers its own moment, and a URL `seek` can race the timeline's arrival, so the
// probe stands the playhead out loud and asks the page who is there.
const w = __world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const say = (k, v) => console.log(`F ${k} ${JSON.stringify(v)}`);
for (let i = 0; i < 60; i++) await raf();
const g0 = w.ghosts();
say('players', (g0.presence?.players || []).map((p) => ({ n: p.name, rows: p.rows, visits: p.visits, first: p.first, last: p.last })));
if (!w.seekSec) { say('result', 'no seekSec API'); throw new Error('api'); }

const cands = [];
for (const p of (g0.presence?.players || [])) {
  const a = w.ghosts().presence.players.find((q) => q.player === p.player);
  cands.push(Math.round((a.first + a.last) / 2), a.first + 1, a.last - 1);
}
const seen = new Set();
const best = [];
for (let t of cands) {
  if (seen.has(t)) continue; seen.add(t);
  if (t < 0) continue;
  w.seekSec(t); if (w.setTimePlay) w.setTimePlay(0); w.ghostApply(t);
  for (let i = 0; i < 6; i++) await raf();
  const g = w.ghosts();
  const here = g.bodies.filter((b) => b.x != null);
  if (!here.length) continue;
  const sk = here.filter((b) => b.skinned).length;
  const clear = here.filter((b) => b.seen !== 'wall').length;
  best.push({ t, standing: here.length, skinned: sk, clear, at: here.map((b) => [b.x, b.y, b.z]), seen: here.map((b) => b.seen) });
}
best.sort((a, b) => (b.clear + b.skinned) - (a.clear + a.skinned) || b.standing - a.standing);
for (const b of best.slice(0, 8)) say('moment', b);
const top = best[0];
if (top) say('frame', `&goto=${top.at[0][0]},${top.at[0][1]},${top.at[0][2]}&seek=${top.t}&time=1&timecls=0`);
say('result', best.length ? `${best.length} moments with bodies; best is t=${top.t} with ${top.standing} standing, ${top.clear} reachable, ${top.skinned} wearing a skin` : 'no body stands at any candidate second');
