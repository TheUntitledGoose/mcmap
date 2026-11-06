// What MSAA and draw resolution cost, on the real GPU. Reports the context's own sample count so a
// flag that did not reach the context cannot be scored as a win.
const w = window.__world;
const st = () => w.state;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gl = document.querySelector('canvas').getContext('webgl2');
const out = { url: location.search,
  samples: gl.getParameter(gl.SAMPLES), ctxAA: gl.getContextAttributes().antialias,
  res: w.res() };
await wait(7000);
const a = st();
out.settle = { fps: Math.round(a.fps), gpuMs: +w.res().gpuMs.toFixed(2),
  cpuMs: +w.res().cpuRenderMs.toFixed(2), verts: a.verts, draws: a.draws };
let f = [], g = [];
for (let i = 0; i < 10; i++) {
  w.orbit(6); await wait(300); w.orbit(-6); await wait(300);
  f.push(st().fps); g.push(w.res().gpuMs);
}
out.orbitFps = Math.round(f.reduce((x, y) => x + y, 0) / f.length);
out.orbitGpuMs = +(g.reduce((x, y) => x + y, 0) / g.length).toFixed(2);
w.orbit(0); await wait(2500);
out.detailR = st().detailR; out.detailCeil = st().detailCeiling;
out.lodOn = st().lodOn; out.lodTiles = st().lodTiles; out.detailMeshes = st().detailMeshes;
out.scaleShown = document.getElementById('scale').textContent;
return out;
