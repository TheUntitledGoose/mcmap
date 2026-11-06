// Ladder probe: after a bake, does the browser actually ask for the fine rung near the eye, keep the
// coarse rung at the horizon, and stop churning? Prints one line per settle so a run reads as numbers.
const w = window.__world, wait = (ms) => new Promise((r) => setTimeout(r, ms));
const row = [];

async function settle(tag, ms = 4000) {
  const t0 = performance.now();
  let last = '', stable = 0, frames = 0;
  while (performance.now() - t0 < ms) {
    await wait(120); frames++; w.tick(4);
    const d = w.lodDiag(), s = w.state, g = w.gridEst();
    const sig = `${d.held}/${d.drawn}/${s.verts}/${g.dirty}/${s.chunks}`;
    if (sig === last) { if (++stable >= 3) break; } else { last = sig; stable = 0; }
  }
  const d = w.lodDiag(), s = w.state, g = w.gridEst();
  row.push({
    tag, settledMs: Math.round(performance.now() - t0), fps: +s.fps.toFixed(1), verts: s.verts,
    lod: { held: d.held, drawn: d.drawn, gaps: d.gaps, refused: d.refused, bad: d.policyBad,
      shade: d.shadeDiff, rung: d.rung, cov: d.cov, covD: d.covDetail, clip: d.clipOn },
    far: { patches: s.shellPatches, shellVerts: s.shellVerts, ovOn: s.ovOn, cells: s.ovCells,
      dirty: g.dirty, cutMs: g.cutMs, tiers: [...new Set(g.tiers)].join('/') },
    detail: { chunks: s.detailMeshes, verts: s.detailVerts, r: Math.round(s.detailRadius) },
    cache: { mb: s.meshCacheMB, parked: s.meshCachedChunks, reused: s.meshReused },
  });
}

await settle('load');
const [tx, , tz] = w.state.target;
const probe = [];
for (const [dx, dz] of [[0, 0], [200, 0], [700, 0], [2000, 0], [6000, 0]]) {
  const a = w.lodAt(tx + dx, tz + dz);
  probe.push({ d: dx, at: a && `${a.rx},${a.rz}`, cell: a && a.cell, held: a && a.held,
    drawn: a && a.drawn, verts: a && a.verts });
}
row.push({ probe });
return row;
