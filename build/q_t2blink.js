// Does a time-machine move blink? A playhead jump marks up to 192 sharp chunks. If a chunk's triangles
// go away when its job is POSTED, the ground under the eye shows the far layer for a worker round trip.
// This samples the sharp mesh count every frame after one jump: dipFrames > 0 means holes were drawn.
// ?keepmesh=1 (default) keeps the old triangles until the new ones land; ?keepmesh=0 is the old flicker.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const s = w.state;
const out = { settings: { time: s.time, terrain: w.histWanted() ? 1 : 0, timeCls: s.timeCls, who: w.ledger().who } };
for (let i = 0; i < 150; i++) { await raf(); w.tick(1); }
const rows = w.time().quads;
w.timeSeekRow(rows - 1);
for (let i = 0; i < 150; i++) { await raf(); w.tick(1); }
const base = { meshes: w.state.detailMeshes, verts: w.state.detailVerts, calls: w.state.drawn,
  vertsAll: w.state.verts, hist: w.hist().chunks };
w.timeSeekRow(0);
let dipFrames = 0, maxDip = 0, minMeshes = base.meshes, samples = [];
for (let i = 0; i < 90; i++) {
  await raf(); w.tick(1);
  const m = w.state.detailMeshes;
  if (i < 20 || i % 10 === 0) samples.push(m);
  if (m < base.meshes) { dipFrames++; maxDip = Math.max(maxDip, base.meshes - m); }
  minMeshes = Math.min(minMeshes, m);
}
for (let i = 0; i < 150; i++) { await raf(); w.tick(1); }
const after = { meshes: w.state.detailMeshes, verts: w.state.detailVerts, calls: w.state.drawn,
  vertsAll: w.state.verts, hist: w.hist().chunks };
out.base = base;
out.after = after;
out.dip = { dipFrames, maxDip, minMeshes, first20Samples: samples.slice(0, 20) };
out.undo = { vertsUndone: base.verts - after.verts, allUndone: base.vertsAll - after.vertsAll,
  sharpSharePct: +(100 * base.verts / base.vertsAll).toFixed(1) };
out.hist = w.hist();
out.errors = { page: out.settings && w.state.bootError, frames: w.state.frameErrors };
return out;
