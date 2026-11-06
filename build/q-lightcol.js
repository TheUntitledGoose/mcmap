(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 70; i++) { __world.tick(10, 16); await wait(40); }
  const st = __world.state;

  // Walk a vertical line down the middle of the frame. Where it crosses into a hole in the ground,
  // the save's skylight must fall off and the vertex bytes must follow the ramp.
  const rows = [];
  for (let y = 120; y <= 700; y += 40) {
    const h = __world.pickState(640, y);
    if (!h || !h.block) { rows.push({ y, none: true }); continue; }
    const [nx, ny, nz] = h.nrm ?? [0, 1, 0];
    const air = [h.block[0] + nx, h.block[1] + ny, h.block[2] + nz];
    const lv = __world.litAt(air[0], air[1], air[2]);
    rows.push({
      y,
      drawn: h.drawn,
      state: (h.state ?? h.shellState ?? '').replace('minecraft:', '').slice(0, 26),
      block: h.block.join(','),
      air: air.join(','),
      lv,
      v: h.vcol ? h.vcol.map((c) => Math.round(Math.max(...c) * 255)) : null,
      px: __world.pick(640, y).slice(0, 3),
    });
  }
  const g = __world.grab();
  let sum = 0, n = 0, dark = 0, darkPix = 0;
  for (let i = 0; i < g.buf.length; i += 4 * 13) {
    const l = (g.buf[i] + g.buf[i + 1] + g.buf[i + 2]) / 3;
    sum += l; n++; if (l < 60) darkPix++;
  }
  return {
    view: { target: st.target, dist: st.dist, detailRadius: st.detailRadius, verts: st.verts, renderMs: __world.renderMs() },
    lightOn: st.lightOn, darkFloor: st.darkFloor, skyScale: st.skyScale,
    frame: { meanLum: +(sum / n).toFixed(1), under60Pct: +(100 * darkPix / n).toFixed(2) },
    rows,
  };
})()
