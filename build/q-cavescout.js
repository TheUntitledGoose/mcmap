(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const look = () => {
    const g = __world.grab();
    let s = 0, n = 0, dark = 0;
    for (let i = 0; i < g.buf.length; i += 4 * 17) {
      const l = (g.buf[i] + g.buf[i + 1] + g.buf[i + 2]) / 3;
      s += l; n++; if (l < 60) dark++;
    }
    return { mean: +(s / n).toFixed(1), darkPct: +(100 * dark / n).toFixed(1) };
  };
  const out = [];
  for (const [yaw, pitch, dist] of [
    [0, -0.25, 60], [1.57, -0.25, 60], [3.14, -0.25, 60], [4.71, -0.25, 60],
    [0.79, 0.15, 34], [2.36, 0.15, 34], [3.93, 0.15, 34], [5.5, 0.15, 34],
  ]) {
    __world.orbit(yaw, pitch, dist);
    for (let i = 0; i < 12; i++) { __world.tick(4, 16); await wait(20); }
    out.push({ yaw: +yaw.toFixed(2), pitch, dist, ...look() });
  }
  return out;
})()
