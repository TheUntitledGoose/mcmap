(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // A camera eval is only an intent: pump frames so chunk fetch, mesh and paint actually happen.
  for (let i = 0; i < 90; i++) { __world.tick(10, 16); await wait(40); }
  const st = __world.state;

  const g = __world.grab();
  let sum = 0, n = 0, black = 0, dark = 0;
  const hist = new Array(8).fill(0);
  for (let i = 0; i < g.buf.length; i += 4 * 13) {
    const l = (g.buf[i] + g.buf[i + 1] + g.buf[i + 2]) / 3;
    sum += l; n++;
    if (l < 8) black++; else if (l < 48) dark++;
    hist[Math.min(7, (l / 32) | 0)]++;
  }

  // Sample what the surface rays hit, and ask the loaded chunk what light that face's air cell has.
  const hits = [], lit = [];
  for (const [x, y] of [[320, 300], [640, 320], [960, 340], [420, 470], [760, 520], [640, 640]]) {
    const h = __world.pickState(x, y);
    if (!h || !h.block) { hits.push({ x, y, none: true }); continue; }
    const [nx, ny, nz] = h.nrm ?? [0, 1, 0];
    const air = [h.block[0] + nx, h.block[1] + ny, h.block[2] + nz];
    const lv = __world.litAt(air[0], air[1], air[2]);
    const raw = __world.light(air[0], air[1], air[2]);
    lit.push(lv);
    hits.push({
      x, y, drawn: h.drawn, state: (h.state ?? h.shellState ?? '').replace('minecraft:', ''),
      block: h.block, airLight: lv, skyBlk: raw,
      vertex: h.vcol ? h.vcol[0].map((v) => Math.round(v * 255)) : null,
      pixel: __world.pick(x, y).slice(0, 3),
    });
  }
  return {
    render: { verts: st.verts, detailVerts: st.detailVerts, shellVerts: st.shellVerts, renderMs: __world.renderMs() },
    load: { inflight: st.inflight, queued: st.queued, missing: st.missing, dirty: st.dirty, meshWait: st.meshWait },
    frame: { meanLum: +(sum / n).toFixed(1), blackPct: +(100 * black / n).toFixed(1), darkPct: +(100 * dark / n).toFixed(1), hist },
    litSpread: { min: Math.min(...lit), max: Math.max(...lit), darkCells: lit.filter((v) => v >= 0 && v < 6).length },
    hits,
  };
})()
