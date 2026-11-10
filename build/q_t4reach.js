// How much of the picture can the VOXEL half of the time machine reach, as a function of framing and
// the full-resolution ceiling? For each config: cursor to the start of the log, grab, cursor to the
// screenshot's row, grab, diff pixels. A playhead move reaches the screen only where a full-resolution
// chunk mesh exists; the far layers are heightfields and keep today's terrain.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 3500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};
w.setTimePlay(0);
await settle(1500);
const ROW = Math.min(w.TLAYER.quads - 1, 27655);

const diff = (a, b) => {
  let changed = 0, big = 0, max = 0;
  const n = Math.min(a.buf.length, b.buf.length);
  for (let i = 0; i < n; i += 4) {
    const d = Math.max(Math.abs(a.buf[i] - b.buf[i]), Math.abs(a.buf[i + 1] - b.buf[i + 1]),
      Math.abs(a.buf[i + 2] - b.buf[i + 2]));
    if (d > max) max = d;
    if (d > 12) { changed++; if (d > 60) big++; }
  }
  return { changed, of: n / 4, pct: +(100 * changed / (n / 4)).toFixed(2), big, max };
};

const run = async (label) => {
  w.timeSeekRow(0);
  await settle(3000);
  const a = w.grab();
  w.timeSeekRow(ROW);
  await settle(4500);
  const b = w.grab();
  const s = w.state;
  return { label, pixels: diff(a, b), fps: Math.round(s.fps), verts: s.verts,
    detailVerts: s.detailVerts, detailRadius: s.detailRadius, detailMeshes: s.detailMeshes,
    chunks: s.chunks, lodVerts: s.lodVerts, shellVerts: s.shellVerts,
    histChunks: w.hist().chunks, histEdits: w.hist().edits, histMarked: w.hist().marked,
    drawn: w.time().drawn };
};

out.sweep = [];
for (const [dist, radius] of [[140, 8], [140, 16], [140, 24], [300, 8], [300, 16], [60, 8]]) {
  w.set('detail', radius);
  w.set('dist', dist);
  await settle(4000);
  out.sweep.push(await run(`dist ${dist} radius ${radius} chunks`));
}
out.note = 'pixels changed between the first logged row and row ' + ROW
  + ' - the reach of the voxel replay at each framing';
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
