// The pixel-limited sharp ring is a panel row now. Does the row exist, is it on, does clicking it
// actually move the sharp ring, and does "close detail" admit when the pixels are the limit?
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : null);
const rowFor = (label) => [...document.querySelectorAll('.panel-row')].find((r) =>
  (r.querySelector('.panel-label') || {}).textContent?.trim() === label);
const rowText = (label) => { const r = rowFor(label); return r ? r.textContent.replace(/\s+/g, ' ').trim().slice(0, 70) : null; };
const rows = [...document.querySelectorAll('.panel-body > .panel-row .panel-label')].map(txt).slice(0, 12);
const out = { rows, keys: w.panelKeys().includes('detailPixels'), presets: w.presets() };
await sleep(4000);
const [x0, y0, z0] = w.state.target;
w.set('dist', 1200);
await sleep(4000);
out.at1200 = { detailPixels: w.state.detailPixels, detailRadius: w.state.detailRadius,
  ceiling: w.state.detailCeiling, detailMeshes: w.state.detailMeshes,
  verts: +(w.state.verts / 1e6).toFixed(1), fps: +w.state.fps.toFixed(0) };
out.text = { close: rowText('close detail'), sharp: rowText('sharp far centre') };
// flip it with the real control, not the API
const row = rowFor('sharp far centre');
const input = row && row.querySelector('input[type=checkbox]');
if (input) { input.checked = !input.checked; input.dispatchEvent(new Event('change', { bubbles: true })); }
await sleep(6000);
out.afterClick = { checked: input ? input.checked : null, detailPixels: w.state.detailPixels,
  detailRadius: w.state.detailRadius, detailMeshes: w.state.detailMeshes,
  verts: +(w.state.verts / 1e6).toFixed(1), fps: +w.state.fps.toFixed(0) };
out.textAfter = { close: rowText('close detail'), sharp: rowText('sharp far centre') };
// and back through the preset
w.set('detailPixels', 1);
await sleep(3000);
out.afterSet = { detailPixels: w.state.detailPixels, detailRadius: w.state.detailRadius,
  detailMeshes: w.state.detailMeshes, verts: +(w.state.verts / 1e6).toFixed(1) };
return JSON.stringify(out, null, 1);
