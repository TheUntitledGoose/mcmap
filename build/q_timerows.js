// The time machine's own rows: the date stamp and the row-count sentence are the longest values the
// panel ever prints, and a collapsed <details> reports zero width, so open it before measuring.
const w = window.__world;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
w.setTime(true);
for (let i = 0; i < 30 && !w.time().tl; i++) await nap(200);
const secs = [...document.querySelectorAll('.panel-section')];
secs.forEach((d) => { d.open = true; });
await nap(200);
w.timeSeekRow(1459);
await nap(200);
const row = (label) => [...document.querySelectorAll('.panel-row')]
  .find((r) => r.textContent.startsWith(label));
const measure = (r) => r && { label: r.querySelector('.panel-label').textContent,
  cols: getComputedStyle(r).gridTemplateColumns,
  vals: [...r.querySelectorAll('input,b')].map((e) => ({ t: e.tagName.toLowerCase(),
    w: e.clientWidth, clip: e.scrollWidth > e.clientWidth + 1, text: e.textContent ?? '' })) };
out.rows = ['playhead', 'changes per second', 'play (K)', 'who', 'x-ray', 'panel width']
  .map((l) => measure(row(l))).filter(Boolean);
out.clipped = [...document.querySelectorAll('.panel .panel-val')]
  .filter((e) => e.scrollWidth > e.clientWidth + 1)
  .map((e) => ({ text: e.textContent, sw: e.scrollWidth, cw: e.clientWidth }));
out.widths = { panel: w.panelWidth(), panelW: w.settings.panelW };
secs.forEach((d) => { d.open = false; });
return out;
