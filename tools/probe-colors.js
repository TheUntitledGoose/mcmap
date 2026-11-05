// State + observed framebuffer colour per screen sample. Groups by state so a "why is this
// patch grey?" question answers itself: the state key arrives with the colour it drew.
// One grabFrame() read for the whole probe: pick() renders per pixel, which is unusable at
// software-GL frame rates.
(() => {
  const f = __world.grab();
  const px = (sx, sy) => {
    const gx = Math.floor((sx + 0.5) * f.dpr), gy = Math.floor((innerHeight - sy - 0.5) * f.dpr);
    const i = (gy * f.w + gx) * 4;
    return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
  };
  const by = new Map();
  for (let sy = 60; sy < innerHeight - 20; sy += 24) {
    for (let sx = 12; sx < innerWidth - 12; sx += 24) {
      const h = __world.pickState(sx, sy);
      if (!h || !h.state) continue;
      const c = px(sx, sy);
      const e = by.get(h.state) || { n: 0, r: 0, g: 0, b: 0, pass: h.pass };
      e.n++; e.r += c[0]; e.g += c[1]; e.b += c[2];
      by.set(h.state, e);
    }
  }
  return [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)
    .map(([k, e]) => `${String(e.n).padStart(4)} pass${e.pass} rgb(${Math.round(e.r / e.n)},${Math.round(e.g / e.n)},${Math.round(e.b / e.n)})  ${k}`);
})()
