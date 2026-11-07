// M12b.4 acceptance: the terrain time machine in a real browser, measured.
//
// The claims, in the order the probe takes them:
//   * the page patches VOXELS, not decals, and says how many chunks and blocks it undid;
//   * the store's payload never changes - a column sampled before, during and after a scrub reads the
//     same block names, so picking, collision and the far layers still answer for the world as it is;
//   * the picture at one camera really changes between "nothing undone" and "everything undone", counted
//     in pixels, and the detail triangle count changes with it;
//   * the far layers are NOT corrected (documented policy), so their vertex counts stay put;
//   * the switch alone, at one playhead, is enough to change the picture - which says the patch, and not
//     the playhead's decals, is what moved the pixels;
//   * a scrub costs a bounded number of chunk re-meshes, and the frames stay playable;
//   * the timeline slice and the cell slice - two independent wire responses - agree on how many rows the
//     chunk under the camera has.
//
// Run:
//   node tools/browser-probe.mjs --gpu --url "http://127.0.0.1:8765/?time=1&timeterrain=1&timecls=0&ledgerwho=0&timeterrainlimit=0&goto=-40,72,-120" \
//     --eval-file build/q_t2terrain.js --wait 90000 --shot 900x500 --out build/shot_t2_undone.png
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const out = { url: location.href };

for (let i = 0; i < 240 && !w.time().tl && !w.time().err; i++) await raf();
out.bootTime = w.time();
out.bootHist = w.hist();
if (!out.bootTime.tl) return out;

// Stand over the loudest chunk the ledger knows about: cx -3, cz -8 -> x -48..-33, z -128..-113. Its own
// ground (tools/column.mjs --cx -3 --cz -8 --x 5 --z 5) is a deepslate base: surface y 84, floors down to
// y 40, and 13 blocks of air above the roof - so that is the y window worth sampling.
w.go(-40, 72, -120);
w.orbit(0.7, 0.9, 150);
await settle(90);
out.camera = { dist: w.settings.dist, chunks: w.state.chunks, ringStuck: w.state.ringStuck };

const drain = async (limitMs = 7000) => {
  const t0 = performance.now();
  let frames = 0;
  while (performance.now() - t0 < limitMs) {
    await raf(); w.tick(1); frames++;
    const s = w.state;
    if (s.dirty === 0 && s.meshQueued === 0 && s.ringStuck[0] === 0) break;
  }
  return { frames, ms: +(performance.now() - t0).toFixed(0), dirty: w.state.dirty };
};

// ---- 1. the voxel truth does not move. Read through the page's own picker, which reads the store: the
// patch never writes there. Names, not numbers, because "air" and "not loaded" are different answers.
const colSample = () => {
  const v = [];
  for (let x = -48; x < -32; x += 2) {
    for (let z = -128; z < -112; z += 2) {
      for (let y = 40; y < 96; y += 2) v.push(String(w.at(x, y, z)));
    }
  }
  return v;
};
const hashOf = (list) => {
  let h = 0;
  for (const s of list) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};
const truthBefore = colSample();
out.truth = { samples: truthBefore.length, hash: hashOf(truthBefore),
  solid: truthBefore.filter((s) => s !== 'null').length,
  kinds: [...new Set(truthBefore)].slice(0, 8) };

// ---- 2. everything undone (playhead 0) against nothing undone (playhead at the log's end)
const snap = () => {
  const s = w.state, info = w.renderer.info, h = w.hist();
  return { verts: s.verts, tris: s.tris, calls: info.render.calls, meshTris: info.render.triangles,
    shellVerts: s.shellVerts, lodVerts: s.lodVerts, ovVerts: s.ovVerts,
    hist: { chunks: h.chunks, edits: h.edits, unknown: h.unknown, builds: h.builds,
      marked: h.marked, patches: h.patches, workerPatches: h.workerPatches,
      patchMs: h.patchMs, workerPatchMs: h.workerPatchMs, sec: h.sec, gen: h.gen } };
};
w.timeSeekRow(0);
out.drainUndone = await drain();
const undone = snap();
const pixelsUndone = w.grab();

w.timeSeekRow(w.time().quads - 1);
out.drainPresent = await drain();
const present = snap();
const pixelsPresent = w.grab();

const countDiff = (A, B) => {
  let n = 0;
  for (let i = 0; i < A.buf.length; i += 4) {
    const d = Math.abs(A.buf[i] - B.buf[i]) + Math.abs(A.buf[i + 1] - B.buf[i + 1])
      + Math.abs(A.buf[i + 2] - B.buf[i + 2]);
    if (d > 24) n++;
  }
  return n;
};
out.ab = {
  size: [pixelsUndone.w, pixelsUndone.h], pixelsChanged: countDiff(pixelsUndone, pixelsPresent),
  shareOfFrame: +(countDiff(pixelsUndone, pixelsPresent) / (pixelsUndone.w * pixelsUndone.h) * 100).toFixed(2),
  detailVerts: { undone: undone.verts, present: present.verts, delta: undone.verts - present.verts },
  detailTris: { undone: undone.tris, present: present.tris, delta: undone.tris - present.tris },
  drawCalls: { undone: undone.calls, present: present.calls },
  farUntouched: { shell: [undone.shellVerts, present.shellVerts], lod: [undone.lodVerts, present.lodVerts] },
  hist: { undone: undone.hist, present: present.hist },
};

// ---- 3. the same A/B done by the SWITCH at one playhead (playhead 0, where the undo is biggest), so the
// delta is the patch and nothing else - not the playhead, not the decals, not streaming.
w.timeSeekRow(0); await drain();
const on = snap(); const pixelsOn = w.grab();
w.set('timeTerrain', false);
await drain();
const off = snap(); const pixelsOff = w.grab();
w.set('timeTerrain', true);
await drain();
const onAgain = snap();
out.abSwitch = {
  pixelsChanged: countDiff(pixelsOn, pixelsOff),
  verts: { on: on.verts, off: off.verts, delta: on.verts - off.verts },
  tris: { on: on.tris, off: off.tris, delta: on.tris - off.tris },
  calls: { on: on.calls, off: off.calls },
  hist: { on: on.hist, off: off.hist, onAgain: onAgain.hist },
};

// ---- 4. the store never moved. Voxel truth is a store question, not a geometry question, so this
// settles rather than drains.
w.timeSeekRow(0); await settle(20);
w.timeSeekRow(Math.round(w.time().quads / 2)); await settle(20);
w.timeSeekRow(w.time().quads - 1); await settle(20);
const truthAfter = colSample();
out.truthAfter = { hash: hashOf(truthAfter), same: hashOf(truthAfter) === out.truth.hash };

// ---- 5. a scrub: how many chunk re-meshes the playhead buys, and what the frames feel like
const rows = w.time().quads;
const t0 = performance.now();
let frames = 0, syncs = 0, maxMarked = 0, edits = 0;
// `hist().builds` and `workerPatchMs` reset at every sync, so summing them across a scrub that syncs
// every frame measures nothing: no window is ever open long enough to install a mesh. The lifetime
// counters do not reset, so a scrub is measured as a delta of those.
const before = w.hist();
// Sweep from the end of the log to the start, so the scrub ENDS in the most-corrected state: that is
// the worst case worth timing, and the settle then says how much re-meshing it took to get there.
for (let i = 0; i <= 60; i++) {
  w.timeSeekRow(Math.round((1 - i / 60) * (rows - 1)));
  syncs++;
  await raf(); w.tick(1); frames++;
  const h = w.hist();
  maxMarked = Math.max(maxMarked, h.marked);
  edits = Math.max(edits, h.chunks);        // chunks holding undone blocks, at their peak in the sweep
}
const scrubWall = performance.now() - t0;
const mid = w.hist();
out.scrub = { steps: syncs, fps: +(frames / (scrubWall / 1000)).toFixed(1), wallMs: +scrubWall.toFixed(0),
  chunksMeshedDuring: mid.buildTotal - before.buildTotal,
  patchMsDuring: +(mid.workerPatchTotalMs - before.workerPatchTotalMs).toFixed(1),
  maxMarked, maxChunksPatched: edits,
  perRemeshMs: +w.state.meshMs.toFixed(1), meshMax: +w.state.meshMax.toFixed(1), hist: w.hist() };
out.drainAfterScrub = await drain();
const after = w.hist();
out.scrub.chunksMeshedAfterSettle = after.buildTotal - before.buildTotal;
out.scrub.patchMsAfterSettle = +(after.workerPatchTotalMs - before.workerPatchTotalMs).toFixed(1);
out.scrub.settledChunksPatched = after.chunks;

// ---- 6. the loudest chunk, named: its edits at both ends of the log, and what the OTHER endpoint says
const loud = { cx: -3, cz: -8 };
w.timeSeekRow(w.time().quads - 1); w.histSync(true);
out.loudChunk = { cx: loud.cx, cz: loud.cz, atEnd: { edits: w.histEditsOf(loud.cx, loud.cz).edits.length / 2,
  stamp: w.histStampOf(loud.cx, loud.cz) } };
w.timeSeekRow(0); w.histSync(true);
out.loudChunk.atStart = (() => {
  const g = w.histEditsOf(loud.cx, loud.cz);
  return { edits: g.edits.length / 2, unknown: g.unknown, truncated: g.truncated, stamp: w.histStampOf(loud.cx, loud.cz) };
})();
try {
  const { readPack } = await import('/shared/ledger-pack.mjs');
  const r = await fetch('/ledger/cells?dim=minecraft:overworld');
  const P = readPack(await r.arrayBuffer());
  let cell = null;
  for (let i = 0; i < P.cellCount; i++) {
    const c = P.cell(i);
    if (c.cx === loud.cx && c.cz === loud.cz) { cell = c; break; }
  }
  const pageRows = w.HIST.byCell?.get(w.HIST.cellsAt.get(`${loud.cx},${loud.cz}`))?.length ?? -1;
  out.crossCheck = { cellRows: cell?.total ?? -1, pageRows, agree: cell?.total === pageRows,
    touchedCells: w.hist().touched, pageCells: w.HIST.cellsAt?.size ?? -1 };
} catch (err) { out.crossCheck = { error: String(err && err.message || err) }; }

out.note = w.histNote();
out.panelKeys = w.panelKeys().filter((k) => /^time/.test(k));
return out;
