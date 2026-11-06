(() => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  return (async () => {
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(10000); __world.tick(250);
    const out = [];
    // cell containing the orbit target: grid-relative i,j -> world chunks
    const cx0 = 184, cz0 = 124;
    let holes = 0, held = 0, det = 0;
    const rows = [];
    for (let dz = 0; dz < 4; dz++) {
      const r = [];
      for (let dx = 0; dx < 4; dx++) {
        const sh = __world.shellAt(cx0 + dx, cz0 + dz);
        const l = __world.lodOf((cx0 + dx) * 16, (cz0 + dz) * 16);
        if (sh) held++; else { holes++; }
        if (l.detail) det++;
        r.push(sh ? 'S' : '-');
      }
      rows.push(r.join(''));
    }
    out.push(`cell chunks ${cx0}..${cx0+3} x ${cz0}..${cz0+3}: shellHeld=${held} shellAbsent=${holes} detailMeshes=${det}`);
    out.push(rows.join(' '));
    // is the cell's top quad present in the live overview mesh? ray straight down at the cell centre
    const hits = __world.pickStack(640, 400, 6).map((h) => `${h.drawn}@(${h.point.join(',')})`);
    out.push('down-ray ' + hits.join(' | '));
    // overview heights across a wide line: where does the plate end?
    const hh = [];
    for (let k = -6; k <= 6; k++) { const o = __world.ovAt(2976 + k * 32, 1989); hh.push(`${k}:${o.h}/${o.state ? o.state.split(':')[1].slice(0,8) : '-'}${o.covered ? 'S' : 'D'}`); }
    out.push('line ' + hh.join(' '));
    out.push('diag ' + JSON.stringify(__world.ovDiag()));
    return out.join('\n');
  })();
})()
