// Does borrowing the close-up pass's mean AO darkening actually bring the far layer's colour closer to
// the detail pass? Same camera, same pixels, only the setting changed - so any move is the setting.
(async () => {
  const settle = (n = 1) => { for (let i = 0; i < n; i++) { __world.tick(20, 16); await new Promise((r) => setTimeout(r, 150)); } };
  __world.orbit(null, null, 700);
  settle(8);

  // Scan a horizontal line; keep the first shell hit and the first detail hit that paint the same block.
  const scan = () => {
    const far = {}, near = {};
    for (let x = 200; x < 1100; x += 7) {
      for (const y of [380, 420, 460, 500]) {
        const h = __world.pickState(x, y);
        if (!h || !h.drawn || !h.state) continue;
        const name = h.state.replace(/^shell:/, '');
        const px = __world.pick(x, y);
        const bag = h.drawn === 'shell' || h.drawn === 'overview' ? far : near;
        if (!bag[name]) bag[name] = { x, y, px: px.slice(0, 3) };
      }
    }
    return { far, near };
  };

  const pair = (s) => {
    const out = [];
    for (const [name, f] of Object.entries(s.far)) {
      const n = s.near[name];
      if (n) out.push({ name, far: f.px, near: n.px, d: Math.max(...f.px.map((v, i) => Math.abs(v - n.px[i]))) });
    }
    return out.sort((a, b) => b.d - a.d).slice(0, 4);
  };

  const rows = [];
  for (const v of [1, 0.931, 0.86]) {
    __world.set('aofar', v);
    settle(10);
    const s = scan();
    rows.push({ aofar: v, pairs: pair(s), shellVerts: __world.state.shellVerts });
  }
  return JSON.stringify(rows, null, 1);
})();
