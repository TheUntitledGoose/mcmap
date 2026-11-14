// Who stands at this second, and where - including the people the skin pack has no face for.
const w = __world; const raf = () => new Promise((r) => requestAnimationFrame(r));
const say = (k, v) => console.log(`Q ${k} ${JSON.stringify(v)}`);
const P = new URLSearchParams(location.search);
for (let i = 0; i < 40; i++) await raf();
const T = +(P.get('tsec') || 0);
w.seekSec(T); if (w.setTimePlay) w.setTimePlay(0); w.ghostApply(T);
for (let i = 0; i < 10; i++) await raf();
const g = w.ghosts();
const names = Object.fromEntries((g.presence?.players || []).map((p) => [p.player, p.name]));
say('at', g.at);
say('bodies', g.bodies.filter((b) => b.x != null).map((b) => ({ n: names[b.player], p: b.player, at: [b.x, b.y, b.z], seen: b.seen, skinned: b.skinned })));
