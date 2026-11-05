// Where does that saturated pink come from? Sample the framebuffer, then ask the renderer what it
// drew there. grabFrame() rows are bottom-origin, pickState() takes CSS pixels.
//
// The interesting question is not "is there pink" but "which states, and with what exact colour":
// a modded purple tree is a real colour, while one fixed rgb repeated across unrelated states means
// a single sprite (or a missing-texture placeholder) is doing the painting.
const g = window.__world.grab();
if (!g) 'no grab';
else {
  const { w, h, buf: rgba } = g;
  const edge = 3;                                       // ignore the framebuffer border, it lies
  const pink = [];
  for (let y = edge; y < h - edge; y += 3) {
    for (let x = edge; x < w - edge; x += 3) {
      const o = (y * w + x) * 4;
      const r = rgba[o], gg = rgba[o + 1], b = rgba[o + 2];
      // saturated magenta/violet: red and blue both strong, green clearly lower
      if (r > 130 && b > 130 && Math.abs(r - b) < 70 && r - gg > 50 && b - gg > 50) pink.push([x, y, r, gg, b]);
    }
  }
  const byRgb = new Map();
  const byState = new Map();
  const hits = [];
  for (const [x, y, r, gg, b] of pink) {
    const p = window.__world.pickState(x, h - y - 1);
    const key = p ? `${p.drawn}|${p.shellState || p.state}` : 'miss';
    const rgb = `${r},${gg},${b}`;
    byRgb.set(rgb, (byRgb.get(rgb) ?? 0) + 1);
    const e = byState.get(key) ?? { n: 0, rgb: new Set(), at: [x, y] };
    e.n++;
    if (e.rgb.size < 4) e.rgb.add(rgb);
    byState.set(key, e);
    if (!hits.some((q) => q.key === key)) hits.push({
      key, at: [x, y], rgb: [r, gg, b], block: p && p.block, point: p && p.point,
      obj: p && p.obj, mat: p && p.mat, vcol: p && p.vcol,
    });
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => [k, v.n ?? v, v.rgb ? [...v.rgb].slice(0, 2) : undefined]);
  ({ pinkCount: pink.length, of: ((w - 2 * edge) * (h - 2 * edge)) / 9 | 0,
    colours: top(byRgb, 6), states: top(byState, 10), hits: hits.slice(0, 6) });
}
