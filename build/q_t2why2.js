// The house chunk is marked, its edits exist, and its mesh never changes. So which gate is closing?
// Everything the drain consults for one chunk, in both states, before and after settle.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };  // NOT a tight tick loop: worker results arrive as messages, and a synchronous loop starves them.
await sleep(0);

const HX = -59, HY = 72, HZ = -130, HCX = -4, HCZ = -9;
const PH_SEC = 100948;
const out = {};
w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3000);
const CX = Math.round(innerWidth / 2), CY = Math.round(innerHeight / 2);
const pick = () => { const p = w.pickState(CX, CY); return p ? { b: p.block, s: p.state, drawn: p.drawn } : null; };

w.settings.timeTerrain = 0; w.histSync(true); await settle(2500);
out.off = { pick: pick(), diag: w.meshDiag(HCX, HCZ), hist: w.histStats() };

w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true);
out.fresh = { diag: w.meshDiag(HCX, HCZ), mark: w.HIST.marks.get(`${HCX},${HCZ}`)?.edits.length ?? null };
await settle(2500);
out.on = { pick: pick(), diag: w.meshDiag(HCX, HCZ), hist: w.histStats(), verts: w.state.detailVerts };
// Force the point of it: the mesh key the page would build now versus the one it installed.
out.sameKey = out.on.diag.mk === out.on.diag.installed;
out.dirtySize = w.state.dirty;
out.ringStuck = w.state.ringStuck;
out.note = w.histNote();
return out;
