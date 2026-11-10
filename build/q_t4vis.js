const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const raf = () => new Promise(r => requestAnimationFrame(r));
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };

while (!window.__world) await sleep(200);
const w = window.__world;
for (let i = 0; i < 40 && !(w.TLAYER && w.TLAYER.built); i++) await settle(300);

// park the playhead where the user's screenshot had it: 8.35 % of the way through this filter,
// which is 27,644 of 331,040 changes
w.setTimePlay(0);
const row = Math.floor(w.TLAYER.quads * 0.0835);
w.timeSeekRow(row);
await settle(3000);            // the terrain re-cut runs on arriving chunks, so wait wall-clock

const snap = (tag) => ({ tag, look: w.TLAYER.look, cap: w.settings.timeGeomMb, cls: w.settings.timeCls,
  tiles: !!w.settings.timeTiles, row: w.TLAYER.cur, drawn: w.TLAYER.drawn, markers: w.TLAYER.quads,
  verts: w.TLAYER.verts, gpuMB: +(w.TLAYER.mesh.geometry.attributes.position.array.byteLength
    / 1048576).toFixed(1), lookMb: w.TLAYER.lookBytes, why: w.TLAYER.lookWhy || '',
  hist: w.histTotals(), cut: w.timeSplit().chunksCut, inRing: w.timeSplit().inRing,
  grow: w.settings.timeGrow, detailR: w.settings.radius,
  meshes: w.state.detailMeshes, totalVerts: w.state.totalVerts });

const out = [snap('parked')];
const fA = w.grab().buf;
// the flat per-change tiles off: this is the layer that paints a green square on the ground
w.overlay().setTiles(0);
await settle(1200);
out.push(snap('tiles_off'));
const fB = w.grab().buf;
w.overlay().setTiles(1);
// and the marks of already-undone terrain must survive a look change: they are marks against the row
// filter, not against how the markers are painted
w.settings.timeLook = w.settings.timeLook === 'blocks' ? 'plates' : 'blocks';
w.timeRebuild();
for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
await settle(1500);
out.push(snap('after_look_change'));
w.settings.timeLook = 'blocks';
w.timeRebuild();
for (let i = 0; i < 40; i++) { await settle(300); if (w.TLAYER.built) break; }
await settle(1500);
out.push(snap('restored_default'));
const diff = (a, b) => { let s = 0, n = 0, mx = 0, ch = 0; const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i += 4) { for (let k = 0; k < 3; k++) { const d = Math.abs(a[i + k] - b[i + k]); s += d; if (d > mx) mx = d; if (d > 24) ch++; } n++; }
  return { meanAbsPerChannel: +(s / (n * 3)).toFixed(2), max: mx, pctPixelsChanged: +(100 * ch / n).toFixed(2) };
};
const pixelsChangedTilesOff = diff(fA, fB);
const fC = w.grab().buf;
console.log(JSON.stringify({ frames: out, pixelsChangedTilesOff,
  split: w.timeSplit(), histNote: w.histNote(), err: w.TLAYER.err }, null, 1));
