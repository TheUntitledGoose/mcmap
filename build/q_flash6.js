// Stickiness must not freeze the ladder: zoom in and the same region slots must go finer, zoom out and
// they may go coarser. Alternate real time (fetches) with tick() (frames), because a synchronous tick
// blocks the fetches that the new rungs need.
const w = window.__world, out = [];
const settle = async (ms, rounds) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, ms));
    w.tick(20);
  }
};
const snap = (tag) => {
  const d = w.lodDiag();
  out.push(`${tag} dist ${w.state.dist ?? '-'}: rung ${JSON.stringify(d.rung)} held ${d.held} drawn ${d.drawn}`
    + ` verts ${d.verts} wanted ${d.wanted} gaps ${d.gaps}`);
};
await settle(700, 4); snap('far  ');
w.orbit(null, null, 300);
await settle(700, 8); snap('near ');
w.orbit(null, null, 1200);
await settle(700, 8); snap('far 2');
return out.join('\n');
