(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 70; i++) { __world.tick(10, 16); await wait(40); }
  const st = __world.state;
  const DARK = st.darkFloor ?? 0.32, GAM = st.darkGamma ?? 0.72;
  const ramp = (l) => st.lightOn ? Math.max(DARK, DARK + (1 - DARK) * Math.pow(l / 15, GAM)) : 1;

  // Sample the frame, and for every hit ask the loaded chunks how much light the air in front of
  // that face carries. Group by (state, face normal): inside one group the sprite and the face shade
  // are identical, so the only thing that may change the vertex brightness is the light.
  const groups = new Map();
  let samples = 0, lit = 0, unlit = 0, detail = 0, shell = 0;
  scan: for (let y = 60; y < 790; y += 22) {
    for (let x = 30; x < 1250; x += 22) {
      const h = __world.pickState(x, y);
      if (++samples > 1500) break scan;
      if (!h || !h.block || !h.vcol) continue;
      samples++;
      if (h.drawn === 'detail') detail++; else if (h.drawn === 'shell') shell++;
      const [nx, ny, nz] = h.nrm ?? [0, 1, 0];
      const air = [h.block[0] + nx, h.block[1] + ny, h.block[2] + nz];
      const lv = __world.litAt(air[0], air[1], air[2]);
      if (lv < 0) continue;
      if (lv >= 14) unlit++;                       // full daylight
      if (lv <= 8) lit++;                          // somewhere the daylight does not reach
      if (h.drawn !== 'detail') continue;
      const v = Math.max(...h.vcol[0]) * 255;
      const key = `${(h.state ?? '').replace('minecraft:', '').slice(0, 22)}|${nx},${ny},${nz}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { n: 0, byLv: new Map(), border: [0, 0, 0, 0] });
      g.n++;
      const e = g.byLv.get(lv) ?? [];
      e.push(v / ramp(lv));
      g.byLv.set(lv, e);
      const onEdge = (air[0] & 15) < 1 || (air[0] & 15) > 14 || (air[2] & 15) < 1 || (air[2] & 15) > 14;
      const bi = onEdge ? (lv < 14 ? 1 : 0) : (lv < 14 ? 3 : 2);
      g.border[bi]++;
    }
  }

  // For each group, compare the brightness of its daylight faces with its shaded faces after
  // dividing out the expected ramp. A flat ratio means the ramp is the whole story; a light-dependent
  // ratio means the light is leaking somewhere else (or not arriving at all).
  const out = [];
  for (const [key, g] of groups) {
    if (g.n < 6) continue;
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    let bright = null;
    for (const [lv, arr] of [...g.byLv.entries()].sort((a, b) => b[0] - a[0])) {
      if (arr.length >= 3 && avg(arr) > 30) { bright = avg(arr); break; }
    }
    if (!bright) continue;
    const rows = [...g.byLv.entries()].sort((a, b) => b[0] - a[0])
      .filter(([, arr]) => arr.length >= 3)
      .map(([lv, arr]) => ({ lv, n: arr.length, rel: +(avg(arr) / bright).toFixed(3), exp: +ramp(lv).toFixed(3) }));
    // `rel` is observed brightness divided by the brightness the light ramp predicts, all relative to
    // the group's brightest row. rel ~ 1 across the whole light range means the ramp is doing exactly
    // the arithmetic it should; rel tracks lv instead means the light never reached the mesh.
    if (rows.length >= 2 && rows[0].lv !== rows[rows.length - 1].lv) {
      const rels = rows.map((r) => r.rel);
      out.push({
        key, n: g.n, lightSpread: rows[0].lv - rows[rows.length - 1].lv,
        flatness: +(Math.max(...rels) / Math.min(...rels)).toFixed(2),
        relByLv: rows.map((r) => `${r.lv}:${r.rel}`).join(' '),
      });
    }
  }
  out.sort((a, b) => b.n - a.n);
  return {
    view: { target: st.target, dist: st.dist, detailRadius: st.detailRadius, verts: st.verts, renderMs: __world.renderMs() },
    lightOn: st.lightOn, darkFloor: DARK, darkGamma: GAM, ao: st.ao,
    samples: { samples, detail, shell, daylight: unlit, shaded: lit, shadedPct: +(100 * lit / Math.max(1, detail)).toFixed(1) },
    // With light applied this is ~1.1 (a corner's level is the average of four cells, so a face on a
    // gradient can be a little off the centre cell's value). With lighting off, brightness does not
    // move at all while the predicted ramp varies by 3.1x, so flatness goes to ~3.
    flatnessSummary: out.length ? { min: Math.min(...out.map((g) => g.flatness)), max: Math.max(...out.map((g) => g.flatness)) } : null,
    groups: out.slice(0, 6),
  };
})()
