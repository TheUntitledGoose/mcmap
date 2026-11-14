// Where do the bodies actually stand at this playhead, and who is reachable from where?
const w = __world; const raf = () => new Promise((r) => requestAnimationFrame(r));
const say = (k, v) => console.log(`W ${k} ${JSON.stringify(v)}`);
for (let i = 0; i < 40; i++) await raf();
const g = w.ghosts();
say('at', g.at); say('standing', g.standing);
say('skins', w.skins());
say('bodies', g.bodies.filter((b) => b.x != null).map((b) => ({ p: b.player, name: g.presence.players.find((x) => x.player === b.player)?.name, at: [b.x, b.y, b.z], seen: b.seen, skinned: b.skinned, slim: b.slim, seat: b.seat })));
say('camera', { target: [w.state.camX ?? null, w.state.camY ?? null, w.state.camZ ?? null] });
