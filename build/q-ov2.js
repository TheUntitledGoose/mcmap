(async () => {
  // Is the overview plate near the camera stale skip data, or does the skip logic itself miss it?
  // Sample, then force a full overview re-cut (toggle the layer off and on) and sample again.
  const st = __world.state;
  const probe = (tag) => {
    const hits = [];
    for (const [x, y] of [[400, 420], [900, 620], [300, 500], [1100, 500]]) {
      const h = __world.pickStack(x, y, 1)[0];
      hits.push(h ? `${h.drawn}@${Math.round(Math.hypot(h.point[0], h.point[2]))}m` : 'SKY');
    }
    const ov = __world.ovAt(0, -50);
    return `${tag} ${JSON.stringify({ hits, cell: ov.cell, covered: ov.covered,
      ovC: __world.state.ovCells, ovS: __world.state.ovSkipped,
      stamp: __world.ovDiag().covStamp, stale: __world.ovDiag().stale })}`;
  };
  const out = [probe('before')];
  __world.panel().set('overview', false);
  __world.tick(5);
  __world.panel().set('overview', true);
  for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 900)); __world.tick(20); }
  out.push(probe('after'));
  return 'LOD10 ' + out.join(' | ');
})()
