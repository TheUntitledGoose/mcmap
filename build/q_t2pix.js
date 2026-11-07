// Pixels, not raycasts: the pick resolves a name from the STORE, so it can never answer "what did the
// replay paint". Two renders at one camera and one playhead, and the geometry count behind them.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
await sleep(0);

const HX = -59, HY = 72, HZ = -130, HCX = -4, HCZ = -9;
const PH_SEC = 100948;                            // 2024-06-01 23:00:38, the moment in the screenshot
w.setTimePlay(0);
w.settings.timeTiles = 0;                         // no decal: any pixel moved is a block
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(2000);

w.settings.timeTerrain = 0; w.histSync(true); await settle(3000); w.timeGoto(PH_SEC);
const off = { verts: w.state.detailVerts, total: w.state.verts, shell: w.state.shellVerts, lod: w.state.lodVerts,
  ov: w.state.ovVerts, meshes: w.state.detailMeshes, diag: w.meshDiag(HCX, HCZ) };
w.tick(1); const fbOff = w.grab().buf;

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(4000); w.timeGoto(PH_SEC);
const on = { verts: w.state.detailVerts, total: w.state.verts, shell: w.state.shellVerts, lod: w.state.lodVerts,
  ov: w.state.ovVerts, meshes: w.state.detailMeshes, diag: w.meshDiag(HCX, HCZ),
  hist: { marked: w.histStats().marked, restore: w.histStats().restore, capped: w.histStats().capped,
    chunks: w.histStats().chunks, edits: w.histStats().edits, builds: w.histStats().builds,
    skipped: w.histStats().skipped, workerPatches: w.histStats().workerPatches } };

let diff = 0, big = 0;
const g = w.grab();
for (let i = 0; i < g.buf.length; i += 4) {
  const d = Math.abs(fbOff[i] - g.buf[i]) + Math.abs(fbOff[i + 1] - g.buf[i + 1]) + Math.abs(fbOff[i + 2] - g.buf[i + 2]);
  if (d > 24) diff++;
  if (d > 150) big++;
}
return { off, on, sameKey: on.diag.mk === on.diag.installed, pixelsChanged: diff, pixelsBig: big,
  of: g.buf.length / 4, vertsDelta: on.verts - off.verts, note: w.histNote(),
  lod: w.lodDiag(), errors: w.state.frameErrors };
