// Pixels that move in the far band *after* a pan stops. During the pan the frame legitimately changes;
// the question is whether it settles. A settle window that keeps moving is the "lower LODs take over
// again the moment the higher ones finish" report.
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
  return `${((moved / px) * 100).toFixed(2)}%/${(sum / px).toFixed(1)}`;
};
await sleep(6000);
let prev = sample(), pd = w.lodDiag(), pflips = pd.flips, pL = pd.loaded, pD = pd.dropped;
const [tx, ty, tz] = w.state.target;
for (let i = 1; i <= 6; i++) {
  w.go(tx + 170 * i, ty, tz + 55 * i);
  await sleep(800);
  const n = sample(), d = w.lodDiag();
  out.push(`pan${i}     moved ${cmp(prev, n)} flips +${d.flips - pflips} L+${d.loaded - pL}/D+${d.dropped - pD} drawn ${d.drawn} rel ${d.release}`);
  prev = n; pflips = d.flips; pL = d.loaded; pD = d.dropped;
}
for (let i = 1; i <= 7; i++) {
  await sleep(1000);
  const n = sample(), d = w.lodDiag();
  out.push(`settle${i}  moved ${cmp(prev, n)} flips +${d.flips - pflips} L+${d.loaded - pL}/D+${d.dropped - pD} drawn ${d.drawn} rel ${d.release}`);
  prev = n; pflips = d.flips; pL = d.loaded; pD = d.dropped;
}
return `href ${location.href}\n` + out.join('\n');
