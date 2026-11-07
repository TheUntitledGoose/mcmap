// The literal click, on the real DOM row, with nothing in the URL but the camera.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
await settle(2500);
const rows = [...document.querySelectorAll('.panel-row')];
const row = rows.find((x) => /time machine/i.test(x.textContent || ''));
const out = { rowsFound: rows.length, rowFound: !!row, before: { time: w.time().on, terrain: w.histWanted() ? 1 : 0 } };
if (row) {
  const box = row.querySelector('input[type=checkbox]');
  out.box = !!box;
  if (box) { box.click(); await settle(3000); }
}
out.after = { time: w.time().on, terrain: w.histWanted() ? 1 : 0, rows: w.time().rows,
  tiles: w.settings.timeTiles, drawn: w.time().drawn, marked: w.hist().marked, chunks: w.hist().chunks,
  edits: w.hist().edits };
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
