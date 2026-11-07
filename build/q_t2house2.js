// Point the camera AT the house and ask the raycast, not the panel: does the wall answer "deepslate
// tiles" today and "grass" at the playhead?
//
// The save says the house (chunk -4,-9, deepslate bricks/tiles, x -59 y 71..73 z -131..-129) was placed
// 2024-06-02 18:42 onward, and 2,180 of its 2,543 voxels have a place row NEWER than the playhead the
// screenshot sat on. So the replay owes that wall. If the ray still says deepslate, the render path is
// lying and the data is fine.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };  // NOT a tight tick loop: worker results arrive as messages, and a synchronous loop starves them.
const out = {};
await sleep(0);

const HX = -59, HY = 72, HZ = -130;                  // a wall voxel the ledger says was placed 06-02 18:42
const HCX = -4, HCZ = -9;
const PH_SEC = 100948;                              // 2024-06-01 23:00:38 base-relative, as the panel showed it
const dec = (c) => ({ x: c & 15, z: (c >> 4) & 15, y: (c >> 8) - 4096 });

w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3000);
const CX = Math.round(innerWidth / 2), CY = Math.round(innerHeight / 2);
const centerPick = () => { const p = w.pickState(CX, CY); return p ? { block: p.block, state: p.state, drawn: p.drawn } : null; };
const at = () => w.at(HX, HY, HZ);

w.settings.timeTerrain = 0; w.histSync(true); await settle(3000);
out.off = { pick: centerPick(), truthAtWallVoxel: at(), verts: w.state.detailVerts, hist: w.histStats() };
const fbOff = (() => { w.tick(1); return w.grab().buf; })();

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true);
await settle(3000);
const m = w.HIST.marks.get(`${HCX},${HCZ}`);
const ed = m ? m.edits : [];
const high = [];
for (let i = 0; i < ed.length; i += 2) { const d = dec(ed[i]); if (d.y >= 66) high.push(`${d.x},${d.y},${d.z}->${ed[i + 1]}`); }
out.houseChunk = {
  stamp: w.histStampOf(HCX, HCZ),
  marked: !!m,
  gen: m?.gen, thisGen: w.HIST.gen,
  edits: ed.length / 2,
  editsAtY66plus: high.length,
  firstEdits: high.slice(0, 8),
  unknown: m?.unknown, truncated: m?.truncated,
};
out.on = { pick: centerPick(), truthAtWallVoxel: at(), verts: w.state.detailVerts, hist: w.histStats(),
  ring: w.state.detailRadius, held: w.state.chunks };

const fbOn = (() => { w.tick(1); return w.grab().buf; })();
let changed = 0;
for (let i = 0; i < Math.min(fbOn.length, 400000); i += 4) {
  if (Math.abs(fbOff[i] - fbOn[i]) > 24) changed++;
}
out.pixelsInFirst100k = changed;
out.centerPixels = (() => { const g = w.grab(); const i = 4 * ((Math.floor(innerHeight / 2) * g.w) + Math.floor(innerWidth / 2)); return [g.buf[i], g.buf[i + 1], g.buf[i + 2]]; })();
let diff = 0;
for (let i = 0; i < Math.min(fbOn.length, fbOff.length); i += 4) {
  if (Math.abs(fbOff[i] - fbOn[i]) + Math.abs(fbOff[i + 1] - fbOn[i + 1]) + Math.abs(fbOff[i + 2] - fbOn[i + 2]) > 30) diff++;
}
out.pixelsChanged = diff;
out.of = fbOff.length / 4;
out.note = w.histNote();
out.errors = { page: w.state.bootError ?? null, frameErrors: w.state.frameErrors ?? 0, workerError: w.state.workerError ?? '' };
return out;
