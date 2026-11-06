// A deterministic pan over detailed ground, then a look at what is painting the frame.
const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [tx, , tz] = w.state.target;
w.go(tx + 150, 110, tz); await sleep(1200); w.tick(2); out.push(['pan1', w.state.verts]);
w.go(tx + 150, 110, tz + 140); await sleep(1500); w.tick(2); out.push(['pan2', w.state.verts]);
const s = w.state, g = w.gridEst(), l = w.lodDiag();
return { href: location.href,
  s: { fps: +s.fps.toFixed(1), verts: s.verts, detail: s.detailMeshes, ov: s.overviewCells },
  lod: { held: l.held, drawn: l.drawn, gaps: l.gaps, cov: l.cov, covD: l.covDetail, covH: l.covHeld,
         clip: l.clipOn, rung: Object.entries(l.rung || {}).filter(([, n]) => n).map(([c, n]) => c + ':' + n).join('/') },
  far: { patches: g.patches, dirty: g.dirty, cutMs: g.cutMs, tiers: g.tiers } };
