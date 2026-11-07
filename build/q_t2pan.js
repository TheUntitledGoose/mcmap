// Does a marked chunk ever get re-cut WITHOUT a camera move?
// The page answered histEditsOf with 189 writes for the chunk under the camera, yet reported "0 chunks
// re-cut, 0 builds" and detail verts moved by 8. If a pan lands the same edits, the marking is right and
// only the in-place re-cut is missing.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 220) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
await sleep(0);
const out = {};
w.setTimePlay(0);
w.settings.timeTiles = 0;
const snap = () => { const s = w.histStats(); return { chunks: s.chunks, edits: s.edits, changes: s.changes,
  builds: s.builds, buildTotal: s.buildTotal, patches: s.patches, verts: w.state.detailVerts }; };
w.timeSeekRow(0);
w.settings.timeTerrain = 1; w.histSync(true);
await settle();
out.inPlace = snap();
w.timeSeekRow(0);
w.go(-236, 78, 153);                            // pan 16 blocks: the same chunk is still in view
await settle();
w.timeSeekRow(0); w.histSync(true);
await settle();
out.afterPan = snap();
w.timeSeekRow(0);
w.settings.timeTerrain = 0; w.histSync(true);
await settle();
out.terrainOff = snap();
out.stats = (() => { const s = w.histStats(); return { marked: s.marked, capped: s.capped, cur: s.cur, sec: s.sec }; })();
out.stamp = w.histStampOf(-15, 9);
return out;
