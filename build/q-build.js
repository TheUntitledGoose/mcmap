(async () => {
  const out = [];
  for (const d of [400, 900]) {
    __world.orbit(null, null, d);
    for (let i = 0; i < 25; i++) { __world.tick(4, 16); await new Promise((r) => setTimeout(r, 120)); }
    const rows = [];
    for (const [x, y] of [[300, 250], [640, 250], [980, 250]]) {
      const hits = (__world.pickStack(x, y, 3) || []).map((h) => {
        const p = h.point;
        return `${h.drawn}@${p ? `${p[0].toFixed(0)},${p[1].toFixed(0)},${p[2].toFixed(0)}` : '?'}${h.shellState ? ' ' + h.shellState : (h.state ? ' ' + h.state : '')}`;
      });
      const lod = __world.lodOf(208 * 16, 143 * 16);
      rows.push({ at: [x, y], hits, tier: lod.tier, cell: lod.cell });
    }
    const sh = __world.shellAt(208, 143) || __world.shellAt(209, 143);
    out.push({ dist: d, rows, shellTops: sh ? { max: Math.max(...sh.tops), min: Math.min(...sh.tops) } : null,
      shellVerts: __world.state.shellVerts, render: __world.renderMs() });
  }
  return out;
})()
