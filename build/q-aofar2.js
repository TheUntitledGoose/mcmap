(async () => {
  const settle = async (n = 1) => { for (let i = 0; i < n; i++) { __world.tick(20, 16); await new Promise((r) => setTimeout(r, 150)); } };
  __world.orbit(null, null, 900);
  await settle(10);

  const scan = () => {
    const far = {}, near = {};
    for (let x = 120; x < 1240; x += 5) {
      for (let y = 300; y < 640; y += 20) {
        const h = __world.pickState(x, y);
        if (!h || !h.drawn || !h.state) continue;
        const name = h.state.replace(/^shell:/, '').replace(/\|.*$/, '');
        const px = __world.pick(x, y);
        const bag = (h.drawn === 'shell' || h.drawn === 'overview') ? far : near;
        const e = bag[name] || (bag[name] = { n: 0, rgb: [0, 0, 0] });
        e.n++;
        for (let i = 0; i < 3; i++) e.rgb[i] += px[i];
      }
    }
    const avg = (b) => { for (const e of Object.values(b)) for (let i = 0; i < 3; i++) e.rgb[i] = Math.round(e.rgb[i] / e.n); return b; };
    return { far: avg(far), near: avg(near) };
  };

  const rows = [];
  for (const v of [1, 0.931]) {
    __world.set('aofar', v);
    await settle(12);
    const s = scan();
    const pairs = [];
    for (const [name, f] of Object.entries(s.far)) {
      const n = s.near[name];
      if (!n || f.n < 4 || n.n < 4) continue;
      pairs.push({ name, farN: f.n, nearN: n.n, far: f.rgb, near: n.rgb,
        d: Math.max(...f.rgb.map((x, i) => Math.abs(x - n.rgb[i]))),
        mean: Math.round(f.rgb.reduce((a, x) => a + x, 0) / 3 - n.rgb.reduce((a, x) => a + x, 0) / 3) });
    }
    rows.push({ aofar: v, pairs: pairs.sort((a, b) => b.farN - a.farN).slice(0, 6) });
  }
  return JSON.stringify(rows, null, 1);
})();
