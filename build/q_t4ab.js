// Does a playhead move reach the PIXELS, and how much of the picture belongs to a layer the replay
// cannot touch? Same page, same camera: seek the cursor to the start of the log, grab, seek to the
// screenshot's row, grab, diff. Then turn the baked far world off and repeat.
// A ray grid is reported too, but a ray hits LOD geometry even where the LOD material discards, so the
// pixel diff is the verdict and the grid only says which layer is in the way.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const settle = async (ms = 3500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};

w.setTimePlay(0);
await settle(2000);
const LAST = w.TLAYER.quads - 1;
const ROW = Math.min(LAST, 27655);

const diff = (a, b) => {
  let changed = 0, big = 0, max = 0, sum = 0;
  const box = [1e9, 1e9, -1e9, -1e9];
  const n = Math.min(a.buf.length, b.buf.length);
  for (let i = 0; i < n; i += 4) {
    const d = Math.max(Math.abs(a.buf[i] - b.buf[i]), Math.abs(a.buf[i + 1] - b.buf[i + 1]),
      Math.abs(a.buf[i + 2] - b.buf[i + 2]));
    sum += d;
    if (d > max) max = d;
    if (d > 12) {
      changed++;
      if (d > 60) big++;
      const px = (i / 4) % a.w, py = Math.floor((i / 4) / a.w);
      box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py);
      box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py);
    }
  }
  return { changed, of: n / 4, pct: +(100 * changed / (n / 4)).toFixed(2), big, max,
    meanAbs: +(sum / (n / 4)).toFixed(2), box, w: a.w, h: a.h };
};

// Which layer the eye is on, on a coarse grid. Caveat: a ray hits baked geometry even where that
// material discards the fragment, so this is "what stands in the way", not "what painted the pixel".
const grid = (nx = 13, ny = 9) => {
  const c = {};
  const tiles = new Set();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = Math.round(((i + 0.5) / nx) * innerWidth);
      const y = Math.round(((j + 0.5) / ny) * innerHeight);
      const hit = w.pickStack(x, y, 1)[0];
      const k = hit ? hit.drawn : 'sky';
      c[k] = (c[k] || 0) + 1;
      if (hit && hit.lodTile) tiles.add(hit.lodTile.split(',')[0]);
    }
  }
  return { cells: c, of: nx * ny, lodRungsSeen: [...tiles] };
};

const frame = () => {
  const s = w.state;
  return { verts: s.verts, detailVerts: s.detailVerts, shellVerts: s.shellVerts, lodVerts: s.lodVerts,
    detailRadius: s.detailRadius, detailMeshes: s.detailMeshes, lodTiles: s.lodTiles,
    shellPatches: s.shellPatches, dist: s.dist };
};

const run = async (label) => {
  w.timeSeekRow(0);
  await settle(3000);
  const a = w.grab();
  const hist0 = { ...w.hist() };
  w.timeSeekRow(ROW);
  await settle(4000);
  const b = w.grab();
  const hist1 = { ...w.hist() };
  return { label, drawn: { start: hist0.builds, end: hist1.builds },
    edits: { start: hist0.edits, end: hist1.edits }, chunksMarked: hist1.marked,
    chunksCut: hist1.chunks, pixels: diff(a, b), frame: frame(), grid: grid() };
};

out.withBakedFar = await run('baked far world on');
w.set('lodtiles', 0);
await settle(3000);
out.liveFarOnly = await run('baked far world off');
w.set('lodtiles', 1);
await settle(2000);

// And the same question at a framing where the full-resolution pass owns the whole view.
w.set('dist', 40);
await settle(3500);
out.closeIn = await run('dist 40, baked far world on');
out.row = ROW;
out.time = w.time();
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
