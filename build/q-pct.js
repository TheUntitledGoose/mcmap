(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = async (d, label) => {
    __world.orbit(null, null, d);
    for (let i = 0; i < 45; i++) { __world.tick(4, 16); await wait(120); }
    const o = (cx, cz) => __world.shellAt(cx, cz);
    const cols = [];
    for (const [cx, cz] of [[208, 143], [208, 144], [209, 143], [207, 143]]) {
      const sh = o(cx, cz);
      if (!sh) { cols.push(`${cx},${cz} none`); continue; }
      const hs = sh.tops;
      const sorted = hs.slice().sort((a, b) => a - b);
      const mx = sorted[sorted.length - 1], med = sorted[Math.floor(sorted.length * 0.5)];
      cols.push(`${cx},${cz} max=${mx} p80=${med}`);
    }
    return { label, dist: __world.state.dist, verts: __world.state.verts,
      shellVerts: __world.state.shellVerts, render: __world.renderMs(),
      patches: __world.state.shellPatches, cols };
  };
  const out = [];
  for (const [d, label] of [[200, '200m'], [600, '600m'], [1200, '1.2km']]) out.push(await row(d, label));
  __world.orbit(null, null, 200); __world.tick(4, 16);
  return out;
})()
