// Does the picture itself change while the camera stands still? Count the pixels that move in the far
// band of the frame - that band is what the user calls flashing. Sampled on a grid, not per pixel.
const w = window.__world, out = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sample = () => {
  const f = w.grab();
  const { buf, w: W, h: H } = f;
  const g = new Uint8Array(Math.ceil(H * 0.26 / 4) * Math.ceil(W / 4) * 3);
  let n = 0;
  for (let y = Math.floor(H * 0.52); y < Math.floor(H * 0.78); y += 4) {
    for (let x = 0; x < W; x += 4) {
      const i = (y * W + x) * 4;
      g[n++] = buf[i]; g[n++] = buf[i + 1]; g[n++] = buf[i + 2];
    }
  }
  return g;
};
const cmp = (a, b) => {
  let moved = 0, sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    sum += d; if (d > 12) moved++;
  }
  const px = a.length / 3;
  return `${((moved / px) * 100).toFixed(2)}% moved, mean delta ${(sum / px).toFixed(2)}`;
};
await sleep(6000);
let prev = sample();
for (let i = 0; i < 5; i++) {
  await sleep(1000);
  const now = sample();
  const d = w.lodDiag();
  out.push(`still t+${(i + 1)}s  ${cmp(prev, now)}  flips ${d.flips} held ${d.held}/${d.drawn} L${d.loaded}/D${d.dropped}`);
  prev = now;
}
return `href ${location.href}\n` + out.join('\n');
