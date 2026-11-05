// Find the geometric relationship between what the flat view draws and atlas.png. A flat 1:1 view
// should match at offset (0,0); anything else means the quad, the viewport mapping or the pixel
// ratio is off by that amount, and a "texture looks wrong" complaint is really a sampling complaint.
//
// Usage: node tools/browser-probe.mjs --url "http://127.0.0.1:8765/?view=flat&debug=1" --eval-file tools/probe-flat-offset.js
(() => {
  const size = __world.state.atlas;
  const g = __world.grab();
  const dpr = g.dpr;
  const cw = Math.min(size, innerWidth) - 8, ch = Math.min(size, innerHeight) - 8;
  const got = (sx, sy) => {
    if (sx < 0 || sy < 0 || sx >= innerWidth || sy >= innerHeight) return null;
    const gx = Math.floor((sx + 0.5) * dpr), gy = Math.floor((innerHeight - sy - 0.5) * dpr);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return null;
    const i = (gy * g.w + gx) * 4;
    return [g.buf[i], g.buf[i + 1], g.buf[i + 2]];
  };
  const want = (sx, sy) => __world.atlasPixel((sx + 0.5) / size, (sy + 0.5) / size);

  const test = (dx, dy, step = 4) => {
    let s = 0, n = 0;
    for (let sy = 8; sy < ch; sy += step) {
      for (let sx = 8; sx < cw; sx += step) {
        const g2 = got(sx + dx, sy + dy), w2 = want(sx, sy);
        if (!g2 || !w2) continue;
        const d = Math.abs(g2[0] - w2[0]) + Math.abs(g2[1] - w2[1]) + Math.abs(g2[2] - w2[2]);
        if (!Number.isFinite(d)) continue;
        s += Math.abs(g2[0] - w2[0]) + Math.abs(g2[1] - w2[1]) + Math.abs(g2[2] - w2[2]); n++;
      }
    }
    return { dx, dy, mean: +(s / n).toFixed(2), n };
  };

  const scan = [];
  for (let dy = -16; dy <= 16; dy += 4) for (let dx = -8; dx <= 8; dx += 4) scan.push(test(dx, dy));
  scan.sort((a, b) => a.mean - b.mean);
  const fine = [];
  for (const s of scan.slice(0, 3)) {
    for (let dy = s.dy - 3; dy <= s.dy + 3; dy++) for (let dx = s.dx - 3; dx <= s.dx + 3; dx++) fine.push(test(dx, dy, 2));
  }
  fine.sort((a, b) => a.mean - b.mean);
  return { dpr, best: fine.slice(0, 6), coarseBest: scan.slice(0, 4), zero: test(0, 0, 4) };
})()
