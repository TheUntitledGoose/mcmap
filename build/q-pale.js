(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  __world.orbit(null, null, 1200);
  for (let i = 0; i < 40; i++) { __world.tick(1, 16); await sleep(6); }
  await sleep(1500);
  const mean = (v) => v ? v[0].map((_, k) => Math.round(v.reduce((a, c) => a + c[k], 0) / 3 * 255)) : null;
  const out = [];
  for (let sx = 480; sx <= 900; sx += 60) {
    for (let sy = 300; sy <= 620; sy += 60) {
      const stack = __world.pickStack(sx, sy, 3);
      if (!stack || !stack.length) { out.push({ sx, sy, hit: 'sky' }); continue; }
      const h = stack[0];
      const p = h.point;
      out.push({
        sx, sy, drawn: h.drawn, state: h.state, sh: h.shellState,
        y: p ? Math.round(p[1]) : null, at: p ? [Math.round(p[0]), Math.round(p[2])] : null,
        rgb: mean(h.vcol), layers: stack.length,
      });
    }
  }
  return out;
})()
