// The ledger overlays' "I can't see the world" A/B, measured on the real GPU path.
//
// The first version of this probe measured nothing, and the reason is worth keeping: it left the
// playhead at the start of the log, where `drawn` is 0, so the time layer had no tiles to draw and
// every pixel diff came out 0 against 136,245 "green" pixels that were the world's own grass and
// leaves. So the playhead is put at the END of the log first, and every number below is measured
// against the tiles-off frame of the same camera - i.e. against what the overlay is covering up.
//
// Two framings are measured, because the answer is distance-dependent and one number would hide that:
// whole-world (a tile is a sprinkle of pixels) and close-in (a tile is a sticker over a block, which
// is where "I can't see" comes from). Each pass compares, at one camera and one playhead:
//   world      tiles off                     - the baseline
//   hard       100% solid, full-block tiles  - what it used to look like
//   soft       45% solid, tiles inset 82%    - the new default
// and then turns the tiles off again to prove the decal mesh is the only thing that left the frame
// (triangles drop by exactly two per drawn quad; voxel, shell, LOD and overview vertices do not move).
//
// Run:
//   node tools/browser-probe.mjs --gpu --url "http://127.0.0.1:8765/?time=1&timecls=2&ledgerwho=0&goto=-40,72,-120" \
//     --eval-file build/q_tilesab.js --wait 90000 --shot 900x500 --out build/shot_tilesab.png
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 90) => {
  for (let i = 0; i < n; i++) { await raf(); w.tick(1); }
  await sleep(250);
  for (let i = 0; i < 30; i++) { await raf(); w.tick(1); }
};
const out = { url: location.href, settings: { time: w.settings.time, timeCls: w.settings.timeCls,
  decalOp: w.settings.decalOp, decalShrink: w.settings.decalShrink, timeTiles: w.settings.timeTiles } };

for (let i = 0; i < 240 && !w.time().tl; i++) await raf();
w.go(-40, 72, -120);
// The playhead at the END: every row this filter has is on screen. At the start there is nothing to
// draw, and an A/B of nothing against nothing is the kind of clean result that hides a bug.
w.timeSeekRow(Math.max(0, w.time().quads - 1));
await settle();
out.boot = { quads: w.time().quads, drawn: w.time().drawn, visible: w.overlay().timeVisible,
  panelHas: ['timeTiles', 'decalop', 'decalshrink', 'timeTerrain'].map((k) => w.panelKeys().includes(k)) };
if (!w.time().drawn) return out;

const grab = () => { w.tick(1); return w.grab(); };
const cmp = (A, B) => {
  let n = 0, sum = 0;
  for (let i = 0; i < A.buf.length; i += 4) {
    const d = Math.abs(A.buf[i] - B.buf[i]) + Math.abs(A.buf[i + 1] - B.buf[i + 1]) + Math.abs(A.buf[i + 2] - B.buf[i + 2]);
    if (d > 24) n++;
    sum += d;
  }
  const px = A.w * A.h;
  return { changed: n, sharePct: +(100 * n / px).toFixed(2), meanChannelDelta: +(sum / px / 3).toFixed(2) };
};
const snap = () => {
  const s = w.state, info = w.renderer.info, h = w.hist();
  return { detailVerts: s.verts, meshTris: info.render.triangles, calls: info.render.calls,
    shellVerts: s.shellVerts, lodVerts: s.lodVerts, ovVerts: s.ovVerts, drawn: w.time().drawn,
    op: w.overlay().timeOp, shrink: w.overlay().shrink, tiles: w.overlay().tiles,
    hist: { chunks: h.chunks, edits: h.edits, builds: h.builds, marked: h.marked } };
};
const fresh = { op: w.settings.decalOp, shrink: w.settings.decalShrink };

/** One framing, measured three ways plus a return to the baseline. */
async function pass(label, dist) {
  w.orbit(0.7, 0.95, dist);
  await settle();
  w.set('timeTiles', false); await settle(60);
  const world = grab(); const worldSnap = snap();
  w.set('timeTiles', true);
  w.overlay().setDecalOp(1); w.overlay().setDecalShrink(1); await settle(60);
  const hard = grab(); const hardSnap = snap();
  w.overlay().setDecalOp(fresh.op); w.overlay().setDecalShrink(fresh.shrink); await settle(60);
  const soft = grab(); const softSnap = snap();
  w.set('timeTiles', false); await settle(60);
  const back = grab(); const backSnap = snap();
  w.set('timeTiles', true); await settle(30);
  return {
    dist, drawn: hardSnap.drawn,
    framePx: world.w * world.h,
    pixelsPerTile: +(hardSnap.drawn ? (cmp(hard, world).changed / hardSnap.drawn) : 0).toFixed(2),
    hardOverWorld: cmp(hard, world),
    softOverWorld: cmp(soft, world),
    hardAgainstSoft: cmp(hard, soft),
    backToWorld: cmp(back, world),                    // must be 0: the framing is stable, not drifting
    meshTris: { world: worldSnap.meshTris, hard: hardSnap.meshTris, soft: softSnap.meshTris,
      tilesOff: backSnap.meshTris, expectMinusTwoPerDrawn: -2 * hardSnap.drawn },
    detailVerts: { world: worldSnap.detailVerts, hard: hardSnap.detailVerts, tilesOff: backSnap.detailVerts },
    farVerts: { world: [worldSnap.shellVerts, worldSnap.lodVerts, worldSnap.ovVerts],
      tilesOff: [backSnap.shellVerts, backSnap.lodVerts, backSnap.ovVerts] },
  };
}
out.far = await pass('whole-world', 1200);
out.close = await pass('close-in', 90);

// ---- the HEAT overlay, which is the one made of genuinely big tiles (one per touched CHUNK) ------
// This is the layer whose old look was a floor of teal over 20,322 chunks, so the same three-way is
// worth its own numbers: old = 0.55 solid and no inset, new = 0.45 solid and 1.44 blocks of inset.
async function heatPass(label, dist) {
  w.orbit(0.7, 0.95, dist);
  await settle();
  w.set('ledger', false); await settle(60);
  const world = grab();
  w.set('ledger', true); await settle(90);
  w.overlay().setDecalOp(0.55); w.overlay().setDecalShrink(1); await settle(90);
  const hard = grab(); const hardOv = w.overlay();
  w.overlay().setDecalOp(fresh.op); w.overlay().setDecalShrink(fresh.shrink); await settle(90);
  const soft = grab(); const softOv = w.overlay();
  w.set('ledger', false); await settle(60);
  const back = grab();
  w.set('ledger', true); await settle(30);
  return {
    label, dist, decals: w.ledger ? w.ledger().quads : null,
    hardOverWorld: cmp(hard, world), softOverWorld: cmp(soft, world),
    hardAgainstSoft: cmp(hard, soft), backToWorld: cmp(back, world),
    inset: { hard: hardOv.heatInset, soft: softOv.heatInset },
    op: { hard: hardOv.heatOp, soft: softOv.heatOp },
  };
}
out.heatFar = await heatPass('whole-world', 1200);
out.heatMid = await heatPass('mid', 300);

// ---- with the terrain undo running, the tiles are the part you can live without ------------------
w.orbit(0.7, 0.95, 90);
w.set('timeTerrain', true);
w.timeSeekRow(0);                                     // fully back: every logged change undone
await settle(150);
const bA = snap(); const pixA = grab();
w.set('timeTiles', true);
await settle(60);
const bB = snap(); const pixB = grab();
out.withTerrain = {
  pixelsChanged: cmp(pixB, pixA),
  drawn: { blocksOnly: bA.drawn, tilesPlusBlocks: bB.drawn },
  hist: { blocksOnly: bA.hist, tilesPlusBlocks: bB.hist },
  detailVerts: { blocksOnly: bA.detailVerts, tilesPlusBlocks: bB.detailVerts },
};
return out;
