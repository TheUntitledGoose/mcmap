// "my screen flashes black every few seconds" - the only thing in this viewer that reallocates the
// drawing buffer (and therefore clears it) is resize(), driven by the auto-resolution governor, which
// is allowed to change the picture at most every 2.5 s. Suspiciously close to "every few seconds".
// Compact output: one line per window, not a history per frame.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const btn = (label) => [...document.querySelectorAll('.panel-actions button')]
  .find((b) => b.textContent.trim() === label);

async function sample(ms) {
  const t0 = performance.now();
  const c0 = w.res().changes;
  const autos = new Set(); const gpu = []; const fps = []; const calls = []; const tris = [];
  let errs = 0;
  while (performance.now() - t0 < ms) {
    await raf(); await raf();
    const r = w.res(), s = w.state, i = w.renderer.info.render;
    autos.add(+r.auto.toFixed(3)); gpu.push(r.gpuMs); fps.push(s.fps);
    calls.push(i.calls); tris.push(i.triangles); errs = s.frameErrors;
  }
  const avg = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  return { reallocs: w.res().changes - c0, autos: [...autos], gpuMs: [Math.min(...gpu).toFixed(1),
    avg(gpu), Math.max(...gpu).toFixed(1)], fps: [Math.min(...fps).toFixed(0), avg(fps),
    Math.max(...fps).toFixed(0)], calls: [Math.min(...calls), Math.max(...calls)],
    tris: [Math.min(...tris), Math.max(...tris)], frameErrors: errs };
}

const out = { url: location.href, gpuTimer: w.res().gpuTimer, targetFps: w.settings.targetFps };
btn('whole world').click();
for (let i = 0; i < 90; i++) await raf();
out.settled = { verts: w.state.verts, drawn: w.state.drawn, res: w.res().scale, auto: w.res().auto };
out.noLedger = await sample(5000);
w.setLedger(true);
await w.ledgerLoad();
for (let i = 0; i < 60; i++) await raf();
const L = w.ledger(); out.ledger = { cells: L.cells, quads: L.quads, kb: L.kb, drawn: L.drawn };
out.ledgerOn = await sample(7000);
w.set('resAuto', 0);                       // governor off: the flat line to compare against
out.ledgerGovernorOff = await sample(5000);
w.setLedger(false);
w.set('resAuto', 1);
return out;
