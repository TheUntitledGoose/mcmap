// Name what is actually on screen: raycast a grid of pixels and tally block states.
// Anything that looks wrong colour-wise should show up here with its real state key.
(() => {
  const tally = new Map();
  let hits = 0, miss = 0;
  for (let sy = 60; sy < innerHeight - 20; sy += 40) {
    for (let sx = 20; sx < innerWidth - 20; sx += 40) {
      const h = __world.pickState(sx, sy);
      if (!h) { miss++; continue; }
      hits++;
      const k = h.state || '(no chunk)';
      const e = tally.get(k) || { n: 0, pass: h.pass, tex: h.quads && h.quads.map((q) => q.id) };
      e.n++;
      tally.set(k, e);
    }
  }
  const rows = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 24)
    .map(([k, e]) => `${String(e.n).padStart(4)} pass${e.pass}  ${k}` +
      (e.tex && e.tex.length ? `  tex=${[...new Set(e.tex)].join(',')}` : ''));
  return { hits, miss, distinct: tally.size, rows };
})()
