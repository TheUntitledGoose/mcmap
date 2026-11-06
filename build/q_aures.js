// The panel must still mount after the resolution row stopped being linear, and the row must drive
// the real drawing buffer rather than just its own text.
const w = window.__world;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(7000);
const gl = document.querySelector('canvas').getContext('webgl2');
const row = [...document.querySelectorAll('.panel-row')].find((r) => /draw resolution/.test(r.textContent));
const out = { bootError: w.state.bootError, keys: w.panelKeys().length,
  samples: gl.getParameter(gl.SAMPLES), pill: document.getElementById('scale').textContent,
  rowText: row ? row.textContent.replace(/\s+/g, ' ').trim() : null };
const before = w.res();
w.set('res', 1.5); await wait(600);
out.after15 = { setting: w.res().setting, scale: w.res().scale, pill: document.getElementById('scale').textContent,
  rowText: row ? row.textContent.replace(/\s+/g, ' ').trim() : null,
  inputMax: row ? row.querySelector('input[type=range]').max : null, inputValue: row ? row.querySelector('input[type=range]').value : null };
w.set('res', 1); await wait(400);
out.back = { setting: w.res().setting, pill: document.getElementById('scale').textContent };
out.presets = w.presets();
out.badPresets = Object.fromEntries(Object.entries(w.presetKeys()).filter(([, ks]) => ks.length && ks.some((k) => !w.panelKeys().includes(k))));
return out;
