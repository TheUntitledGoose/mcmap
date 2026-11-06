// Does the baked far layer keep changing its own mind while the camera stands still?
// `flips` counts region slots whose asked rung changed between consecutive passes.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (t) => { const d = w.lodDiag(); const s = w.state;
    return { t, flips: d.flips, held: d.held, drawn: d.drawn, loaded: d.loaded, dropped: d.dropped,
      gaps: d.gaps, want: d.wanted, infl: d.inflight, rung: d.rung, verts: (d.verts / 1e6).toFixed(2),
      fps: +s.fps.toFixed(1) }; };
  const rows = [];
  await sleep(9000); rows.push(row('settle'));
  for (let i = 0; i < 8; i++) { await sleep(1000); rows.push(row('s' + (i + 1))); }
  const [x, y, z] = w.state.target;
  w.go(x + 600, y, z + 200);
  await sleep(2500); rows.push(row('pan'));
  for (let i = 0; i < 10; i++) { await sleep(1000); rows.push(row('p' + (i + 1))); }
  const d = w.lodDiag();
  return JSON.stringify({ cellPx: d.cellPx, maxPx: d.cellMaxPx, budget: d.budget,
    cap: d.cap, indexed: d.indexed, bad: d.policyBad, rows, flipLog: d.flipLog });
})()
