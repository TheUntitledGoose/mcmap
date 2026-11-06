(async () => {
  const settle = async (n = 1) => { for (let i = 0; i < n; i++) { __world.tick(20, 16); await new Promise((r) => setTimeout(r, 150)); } };
  const centre = () => {
    let n = 0; const rgb = [0, 0, 0]; const states = {};
    for (let x = 610; x <= 670; x += 5) for (let y = 330; y <= 390; y += 5) {
      const h = __world.pickState(x, y);
      if (!h || !h.drawn) continue;
      const p = __world.pick(x, y);
      n++; for (let i = 0; i < 3; i++) rgb[i] += p[i];
      const k = h.drawn + ':' + String(h.state || '').replace(/\|.*$/, '').replace(/^.*:/, '');
      states[k] = (states[k] || 0) + 1;
    }
    return { n, rgb: rgb.map((v) => Math.round(v / n)), top: Object.entries(states).sort((a, b) => b[1] - a[1])[0] };
  };
  const col = __world.column(0, 0, 2);
  const surf = col && col.length ? col[0] : null;
  const out = { column: surf ? { y: surf.y, state: surf.state } : (col && col.error) || null };
  __world.go(0, surf ? surf.y : 112, 0);
  __world.orbit(0, -1.05, 60);
  await settle(10);
  out.detail = centre();
  out.far = [];
  for (const v of [1, 0.931, 0.86]) {
    __world.set('aofar', v);
    __world.orbit(null, null, 900);
    await settle(12);
    const f = centre();
    f.aofar = v;
    f.dMean = Math.round(f.rgb.reduce((a, x) => a + x, 0) / 3 - out.detail.rgb.reduce((a, x) => a + x, 0) / 3);
    out.far.push(f);
  }
  return JSON.stringify(out, null, 1);
})();
