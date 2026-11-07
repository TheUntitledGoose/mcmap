await new Promise((r) => setTimeout(r, 0));
// The three time-machine hints must read as measured facts, not old theory.
const w = window.__world;
const rows = [...document.querySelectorAll('.row')];
const find = (key) => {
  const el = rows.find((r) => r.dataset.key === key) || rows.find((r) => r.textContent.includes(key));
  return el ? el.textContent.replace(/\s+/g, ' ') : null;
};
const det = [...document.querySelectorAll('details')];
det.forEach((d) => { d.open = true; });
const hints = [...document.querySelectorAll('.hint, .sub, [class*=hint]')]
  .map((e) => e.textContent.replace(/\s+/g, ' ')).filter((t) => /overlay memory|steps down|reads as building/i.test(t));
return { bootError: w.state.bootError, frameError: w.state.frameError, panelKeys: w.panelKeys().includes('timeGeomMb'),
  lookRow: find('a change looks like'), geomRow: find('overlay memory'), hints, nHints: hints.length };
