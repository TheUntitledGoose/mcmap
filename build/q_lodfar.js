// Whole-world view: does the baked layer still cover the world, and does holding fine rungs push the
// drawn vertex total past what the budget was for?
const w = window.__world, out = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await sleep(9000);
const d = w.lodDiag(), s = w.state;
out.push({ verts: s.verts, lodVerts: d.verts, budget: d.budget, rel: d.release,
  held: d.held, drawn: d.drawn, gaps: d.gaps, ask: d.ask, rung: d.rung, flips: d.flips,
  L: d.loaded, D: d.dropped, costIdx: d.costFromIndex, rect: d.rect, scale: w.gridEst().costScale });
await sleep(4000);
const d2 = w.lodDiag();
out.push({ t: '+4s', flips: d2.flips, held: d2.held, drawn: d2.drawn, lodVerts: d2.verts, rel: d2.release,
  L: d2.loaded, D: d2.dropped, gaps: d2.gaps, ask: d2.ask });
return JSON.stringify(out);
