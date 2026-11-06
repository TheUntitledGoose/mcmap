(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 45; i++) { __world.tick(6, 16); await wait(30); }
  const g = __world.grab();
  let s = 0, n = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (let i = 0; i < g.buf.length; i += 4 * 11) {
    const l = (g.buf[i] + g.buf[i + 1] + g.buf[i + 2]) / 3;
    s += l; n++;
    if (l < 24) b0++; else if (l < 64) b1++; else if (l < 128) b2++; else b3++;
  }
  const st = __world.state;
  return { mean: +(s / n).toFixed(1), lumBands: [b0, b1, b2, b3].map((v) => +(100 * v / n).toFixed(1)),
    lightOn: st.lightOn, darkFloor: st.darkFloor, skyScale: st.skyScale, detailVerts: st.detailVerts };
})()
