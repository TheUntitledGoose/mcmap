// What is the black? Sample the framebuffer, then ray-pick the darkest pixels and report which
// mesh/state is actually under them. grabFrame() gives { buf, w, h } with row 0 at the *bottom*.
const g = window.__world.grab();
if (!g) 'no grab';
else {
  const { w, h, buf: rgba } = g;
  const dark = [];
  for (let y = 0; y < h; y += 7) {
    for (let x = 0; x < w; x += 7) {
      const o = (y * w + x) * 4;
      const lum = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
      if (lum < 40) dark.push([x, y, rgba[o], rgba[o + 1], rgba[o + 2], Math.round(lum)]);
    }
  }
  const hits = [];
  const seen = new Set();
  for (const [x, y, r, gg, b, lum] of dark) {
    const sy = h - y - 1;                       // grab rows are bottom-origin, pick() is CSS
    const p = window.__world.pickState(x, sy);
    const key = p ? `${p.block.join(',')}|${p.pass}` : 'miss';
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ at: [x, y], rgb: [r, gg, b], lum, hit: p && { block: p.block, pass: p.pass, state: p.state && p.state.k } });
    if (hits.length >= 10) break;
  }
  ({ darkCount: dark.length, of: (w * h) / 49 | 0, hits });
}
