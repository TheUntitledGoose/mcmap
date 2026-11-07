// The playhead row now follows the thumb (`live: true`) and re-cuts terrain on release (`end`). Prove both
// halves: an `input` event alone must move the cursor and the decal count, and it must NOT force a terrain
// sync past the 64-row self-throttle; a `change` event must force one.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const out = { settings: { time: w.state.time, terrain: w.histWanted() ? 1 : 0, step: w.hist().step } };
await settle(150);
const row = [...document.querySelectorAll('.panel-row')].find((x) => /playhead/i.test(x.textContent || ''));
const sl = row.querySelector('input[type=range]');
const date = () => (row.querySelector('.panel-val')?.textContent || '').trim();
const at = () => ({ cur: Math.round(w.time().cur), drawn: w.time().drawn, histCur: w.hist().cur,
  gen: w.HIST.gen, marked: w.hist().marked, chunks: w.hist().chunks, date: date(), sec: w.time().sec });
w.timeSeekRow(0); await settle(60);
out.atRow0 = at();
sl.value = '500';
sl.dispatchEvent(new Event('input', { bubbles: true }));
await raf(); w.tick(1);
out.afterInputOnly = at();
// Same gesture distance again: under the 64-row throttle this must not bump the sync generation.
sl.value = '501';
sl.dispatchEvent(new Event('input', { bubbles: true }));
await raf(); w.tick(1);
out.afterTinyInput = at();
sl.dispatchEvent(new Event('change', { bubbles: true }));
await raf(); w.tick(1);
out.afterChange = at();
out.shown = (row.querySelector('.panel-val')?.textContent || '').trim();
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
