const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (tag) => {
  const s = w.state, g = w.gridEst(), l = w.lodDiag();
  return { tag, fps: s.fps, verts: s.verts, lod: l.held, drawn: l.drawn,
           rung: Object.entries(l.rung || {}).filter(([, n]) => n).map(([c, n]) => c + ':' + n).join('/'),
           cov: l.cov, covH: l.covHeld, covD: l.covDetail, gaps: l.gaps,
           patches: g.patches, ov: w.state.overviewCells, detail: s.detailMeshes };
};
const [tx, , tz] = w.state.target;
w.go(tx + 150, 110, tz);                                  // one deterministic pan
await sleep(+(w.settings?.probeWait || 300));             // how long after the pan we look
w.tick(2);
out.push(snap('after pan'));
return { href: location.href, out };
