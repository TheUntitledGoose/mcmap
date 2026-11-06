(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  __world.orbit(null, null, 300);
  for (let i = 0; i < 50; i++) { __world.tick(1, 16); await sleep(6); }
  await sleep(1500);
  const rows = [];
  for (const sx of [540, 600, 660, 720]) {
    const st = __world.pickStack(sx, 430, 10);
    const fb = __world.pick(sx, 430);
    rows.push({
      sx, fb, layers: st.map((h) => ({
        drawn: h.drawn, at: h.point.map((v) => Math.round(v)),
        s: (h.shellState ?? h.state ?? '?').replace('minecraft:', ''),
        op: h.op,
        v: h.vcol ? h.vcol[0].map((v) => +v.toFixed(3)) : null,
      })),
    });
  }
  return rows;
})()
