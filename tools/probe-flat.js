// Page-side check that the atlas texture that reached the GPU is the atlas.png that was baked.
// The flat view (?view=flat) draws one 1:1 unlit quad of the atlas in an orthographic scene, so a
// framebuffer pixel at screen (sx, sy) must equal atlas.png pixel (sx, sy). Anything else means the
// upload, the colour space, or the quad's uv is wrong - and that is worth knowing before blaming the
// mesher for how textures look.
//
// Usage: node tools/browser-probe.mjs --url "http://127.0.0.1:8765/?view=flat&debug=1" --wait 3000 --eval-file tools/probe-flat.js
(() => {
  const size = __world.state.atlas;
  const g = __world.grab();
  const dpr = g.dpr;
  const cw = Math.min(size, innerWidth), ch = Math.min(size, innerHeight);
  const px = (sx, sy) => {
    // CSS pixels -> device pixels; the buffer comes back with row 0 at the bottom
    const gx = Math.floor((sx + 0.5) * dpr), gy = Math.floor((innerHeight - sy - 0.5) * dpr);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return null;
    const i = (gy * g.w + gx) * 4;
    return [g.buf[i], g.buf[i + 1], g.buf[i + 2], g.buf[i + 3]];
  };
  const cmp = (sx, sy) => {
    const got = px(sx, sy);
    const want = __world.atlasPixel((sx + 0.5) / size, (sy + 0.5) / size);
    if (!got || !want) return null;
    return { got, want, d: Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]) };
  };

  let n = 0, sum = 0, worst = 0, worstAt = null, over24 = 0, alphaBad = 0;
  for (let sy = 1; sy < ch; sy += 2) {
    for (let sx = 1; sx < cw; sx += 2) {
      const c = cmp(sx, sy);
      if (!c) continue;
      if (c.got[3] !== 255) alphaBad++;
      n++; sum += c.d;
      if (c.d > 24) over24++;
      if (c.d > worst) { worst = c.d; worstAt = [sx, sy, c.got.slice(0, 3), c.want.slice(0, 3)]; }
    }
  }

  // A vertical flip shows up as the bands disagreeing by roughly the atlas height, so compare
  // screen-space bands against image-space bands directly.
  const band = (from, to, wantFlipped) => {
    let s = 0, c = 0;
    for (let sy = Math.floor(ch * from); sy < Math.floor(ch * to); sy += 5) {
      for (let sx = 1; sx < cw; sx += 11) {
        const got = px(sx, sy);
        const v = wantFlipped ? 1 - (sy + 0.5) / size : (sy + 0.5) / size;
        const want = __world.atlasPixel((sx + 0.5) / size, v);
        if (!got || !want) continue;
        s += Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]); c++;
      }
    }
    return +(s / c).toFixed(2);
  };
  return {
    viewport: [innerWidth, innerHeight], drawingBuffer: [g.w, g.h], compared: n,
    meanAbsDiffPerPx: +(sum / n).toFixed(3), over24, worst, worstAt, alphaBad,
    asDrawn: band(0, 1, false), ifFlipped: band(0, 1, true),
  };
})()
