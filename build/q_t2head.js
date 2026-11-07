// What does dragging the playhead slider actually do? The cursor is a ROW index and the value shown is a
// wall clock, so a thumb that means "half way through the log's 822 days" and a cursor that means "half way
// through 90,045 changes" are two different claims. This walks the slider and prints both, plus the drawn
// count the world actually shows, plus what the panel prints.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const out = { settings: { time: w.state.time, timeCls: w.state.timeCls, who: w.ledger().who } };
for (let i = 0; i < 150; i++) { await raf(); w.tick(1); }
const row = [...document.querySelectorAll('.panel-row')].find((r) => /playhead/i.test(r.textContent || ''));
out.found = !!row;
out.labels = [...document.querySelectorAll('.panel-row')].slice(0, 40)
  .map((r) => (r.querySelector('.panel-label')?.textContent || '').trim()).filter(Boolean).slice(0, 24);
if (!row) return out;
const shown = () => (row.querySelector('.panel-val')?.textContent || row.textContent).replace(/\s+/g, ' ').trim();
const sl = row.querySelector('input[type=range]');
out.slider = sl ? { min: sl.min, max: sl.max, step: sl.step, value: sl.value } : null;
out.steps = [];
for (const p of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
  const v = Math.round(+sl.min + p * (+sl.max - +sl.min));
  sl.value = String(v);
  sl.dispatchEvent(new Event('input', { bubbles: true }));
  sl.dispatchEvent(new Event('change', { bubbles: true }));
  await raf(); w.tick(1);
  const t = w.time();
  out.steps.push({ thumb: v, shown: shown(), cur: Math.round(t.cur), sec: t.sec, at: t.at,
    drawn: t.drawn, span: t.span, base: t.base });
}
return out;
