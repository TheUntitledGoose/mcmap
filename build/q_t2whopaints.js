// Who paints the house? Turn the coarse layers off one at a time, then A/B the playhead with only the
// layer the terrain undo actually corrects.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };

const HX = -59, HY = 72, HZ = -130;
const PH_SEC = 100948;
w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(2500);
const shot = () => { w.tick(1); return w.grab().buf; };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) { if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; } return n; };
const out = { of: shot().length / 4 };

const all = shot();
w.settings.shellOn = false; await settle(400); const noShell = shot();
w.settings.lod = 0; await settle(400); const noShellLod = shot();
w.settings.overview = 0; await settle(400); const detailOnly = shot();
out.pixels = {
  shellPaints: diff(all, noShell), lodPaints: diff(noShell, noShellLod),
  overviewPaints: diff(noShellLod, detailOnly),
  verts: { all: w.state.verts, detail: w.state.detailVerts, total: w.state.total, shell: w.state.shell, lod: w.state.lod, ov: w.state.ov },
};

w.settings.timeTerrain = 0; w.timeGoto(PH_SEC); w.histSync(true); await settle(2500); w.timeGoto(PH_SEC);
const off = shot(); const offV = w.state.total;
w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true); await settle(3500); w.timeGoto(PH_SEC);
const on = shot();
out.detailOnlyAb = {
  pixelsChanged: diff(off, on), vertsOff: offV, vertsOn: w.state.total,
  builds: w.histStats().builds, chunks: w.histStats().chunks, edits: w.histStats().edits,
};

w.settings.shellOn = true; w.settings.lod = 1; w.settings.overview = 1; await settle(800);
const onAll = shot();
w.settings.timeTerrain = 0; w.histSync(true); await settle(2500); w.timeGoto(PH_SEC);
const offAll = shot();
out.everythingAb = { pixelsChanged: diff(offAll, onAll) };
out.errors = w.state.frameErrors;
return out;
