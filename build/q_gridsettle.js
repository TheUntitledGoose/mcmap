// What the far grid actually looks like when it is asked to stand still, so a pixel diff between two
// code paths can be attributed: same tiers, same patch count, same verts => a geometry difference is a
// bug; different tier mix or cost walk => the two paths settled in different places.
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(14000);
  const g = w.gridEst(), s = w.state;
  const hist = {};
  for (const t of g.tiers) hist[t] = (hist[t] || 0) + 1;
  return {
    href: location.href.slice(1), fps: +s.fps.toFixed(1),
    patches: s.shellPatches, shellVerts: s.shellVerts, dirty: g.dirty, cuts: g.cuts,
    cutMs: g.cutMs, jobs: g.jobs, posted: g.posted, dropped: g.dropped, outside: g.outside,
    costScale: g.costScale, floorBoost: g.floorBoost, vpc: g.vpc, estVerts: g.estVerts,
    cellPx: g.cellPx, caps: g.caps, tiers: hist, markWhy: s.markWhy ?? null,
    cells: s.shellCells, tiersLabel: s.shellTiers, skinRadius: s.skinRadius,
    detailRadius: s.detailRadius, shellHeld: s.shellHeld, shellMissing: s.shellMissing,
  };
})()
