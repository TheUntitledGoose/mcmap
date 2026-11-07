// Panel geometry: does the widest thing the value column prints actually fit, and does the resize work?
// A clipped value is measured, not eyeballed: scrollWidth against clientWidth on every value cell.
// Waits are setTimeout, not requestAnimationFrame: a headless page that considers itself invisible
// stops producing frames, and an raf-only probe then hangs forever.
const w = window.__world;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const clipped = () => [...document.querySelectorAll('.panel .panel-val')]
  .filter((e) => e.scrollWidth > e.clientWidth + 1)
  .map((e) => ({ text: e.textContent, sw: e.scrollWidth, cw: e.clientWidth }));
const bars = () => [...document.querySelectorAll('.panel input[type=range]')].map((e) => e.clientWidth);
const at = (label) => ({ label, widthPx: w.panelWidth(), setting: w.settings.panelW,
  clipped: clipped(), barMin: Math.min(...bars()), barMax: Math.max(...bars()) });

const out = {};
w.timeSeekRow(1459);                                   // the date stamp is the widest value printed
await nap(300);
out.boot = at('boot 396');

const grip = document.querySelector('.panel-grip');
const edge = (dx) => grip.getBoundingClientRect().left + dx;
const ev = (type, x) => grip.dispatchEvent(new PointerEvent(type, {
  bubbles: true, clientX: x, clientY: grip.getBoundingClientRect().top + 40, pointerId: 7, isPrimary: true,
}));
ev('pointerdown', edge(0));
ev('pointermove', edge(-150));
out.midDrag = { widthPx: w.panelWidth(), dragging: grip.classList.contains('dragging'), setting: w.settings.panelW };
ev('pointerup', edge(-150));
await nap(150);
out.afterDrag = at('after a 150 px drag');

w.set('panelW', 360); await nap(150); out.atMin = at('at the 360 px floor');
w.set('panelW', 620); await nap(150); out.atWide = at('at 620 px');
w.set('panelW', 396); await nap(150); out.backDefault = at('back to 396');
out.hasRow = w.panelKeys().includes('panelW');
try { out.stored = JSON.parse(localStorage.getItem('darkrpg.viewer.settings.v1') ?? 'null')?.panelW ?? null; }
catch { out.stored = 'no store'; }
return out;
