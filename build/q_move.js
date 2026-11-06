// Price the motion floor: a continuous drag, then a stop. Sampling without tick() on purpose - a pan
// is a stream of frames, and a probe that blocks the stack measures something else.
const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [sx, , sz] = w.state.target;
let prev = null, prev2 = null, fpsSum = 0, fpsN = 0, peakDirty = 0, peakVerts = 0;
for (let step = 0; step < 12; step++) {
  w.go(sx + step * 40, 110, sz + step * 18);
  await sleep(260);
  const st = w.state, g = w.gridEst();
  const t = st.shellTiersLive.slice();
  let rev = 0;
  if (prev && prev2 && prev.length === t.length && prev2.length === t.length) {
    for (let i = 0; i < t.length; i++) if (t[i] === prev2[i] && t[i] !== prev[i]) rev++;
  }
  fpsSum += st.fps; fpsN++;
  peakDirty = Math.max(peakDirty, g.dirty); peakVerts = Math.max(peakVerts, st.verts);
  out.push(`drag${step} moving ${g.moving} scale ${g.moveScale} tiers ${JSON.stringify(t.reduce((a, v) => (a[v] = (a[v] | 0) + 1, a), {}))}`
    + ` rev ${rev} dirty ${g.dirty} cuts ${g.cuts} cutMs ${g.cutMs.toFixed(0)} fps ${st.fps.toFixed(1)} verts ${st.verts} shell ${st.shellVerts}`);
  prev2 = prev; prev = t;
}
// Let go of the mouse: the refine pass is one retier, and then the queue has to drain.
for (let i = 0; i < 5; i++) {
  await sleep(900);
  const st = w.state, g = w.gridEst();
  out.push(`settle${i} moving ${g.moving} scale ${g.moveScale} tiers ${JSON.stringify(st.shellTiersLive.reduce((a, v) => (a[v] = (a[v] | 0) + 1, a), {}))}`
    + ` dirty ${g.dirty} cuts ${g.cuts} fps ${st.fps.toFixed(1)} verts ${st.verts} shell ${st.shellVerts}`);
}
return `href ${location.href}\npeak dirty ${peakDirty} peak verts ${peakVerts} mean fps ${(fpsSum / fpsN).toFixed(1)}\n` + out.join('\n');
