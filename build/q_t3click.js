// M12b tier 3: does the entry point the user actually touches work, and what does it cost?
//
// Two entry points, both fired as the page fires them:
//   a click at a screen pixel   -> askAt(x, y)
//   the T key                   -> ledgerAskCentre()
//
// The probe asks at a plain block, then at a time-machine marker, and reports `why` when there is no
// answer, because "nothing happened" and "there is no row there" are different reports.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 1500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const out = {};
out.settings = (() => { const s = w.settings; return { time: s.time, look: s.timeLook, geom: s.timeGeomMb, hover: s.hover, hoverMs: s.hoverMs, dist: +w.state.dist.toFixed(1) }; })();

// ---- 1. plain page: click a block that is standing, whether or not the ledger was ever opened ----
await settle(1500);
out.plain = {
  pick: w.pickState(460, 300),
  why: w.ledger().askWhy,
  metaBefore: w.ledger().meta,
  asks: w.ledger().asks,
  cardRows: w.ledger().cardRows,
};

// ---- 2. turn the time machine on the way the panel does, and settle ----
w.setTime(1); w.setTimeLook('blocks');
await settle(3000);
out.time = { drawn: w.time().drawn, look: w.time().look, quads: w.time().quads, err: w.time().err, edits: w.hist().edits };
if (!w.time().drawn) { w.timeGoto(w.time().cur + 1); await settle(2500); out.time.afterGoto = w.time().drawn; }

// ---- 3. hover: the outline follows the drawn world, and says when a change sits on it ----
const canvas = document.querySelector('canvas');
const hoverAt = async (sx, sy) => {
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: sx, clientY: sy, bubbles: true }));
  w.setHover(1);
  for (let i = 0; i < 5; i++) { w.tick(1); await sleep(60); }
  const h = w.hover();
  return { at: h.at, from: h.from, changes: h.changes, why: h.why, ms: +h.ms.toFixed(2), passes: h.passes, everyMs: h.everyMs, box: !!h.at };
};
out.hoverCentre = await hoverAt(450, 300);

// the cheap question the outline needs: does a drawn change touch this voxel? no raycast involved
const v = out.hoverCentre.at;
out.cheapLookup = v ? { at: v, hit: w.timeDrawnAt(v[0], v[1], v[2]) } : null;
const t0c = performance.now();
for (let i = 0; i < 200; i++) if (v) w.timeDrawnAt(v[0], v[1], v[2]);
out.cheapLookupMsEach = v ? +((performance.now() - t0c) / 200).toFixed(4) : null;

// ---- 4. click a marker, and say what the answer cost ----
out.markerRay = w.timeHitProbe(900);
out.markerRay.voxelDist = out.markerRay.voxel
  ? Math.round(Math.max(Math.abs(out.markerRay.voxel[0] - w.state.target[0]), Math.abs(out.markerRay.voxel[2] - w.state.target[2])))
  : null;
const px = out.markerRay.probe;
out.clickOnMarker = px ? { asksBefore: w.ledger().asks, answer: await w.askAt(px[0], px[1]), why: w.ledger().askWhy } : null;
out.clickRayMs = +w.hover().clickRayMs.toFixed(1);
out.cardAfterMarker = { asks: w.ledger().asks, rows: w.ledger().cardRows, total: w.ledger().cardTotal };

// ---- 5. T: the keyboard entry point uses the same path ----
document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }));
await sleep(500); w.tick(1); await sleep(500);
out.keyT = { asks: w.ledger().asks, rows: w.ledger().cardRows, total: w.ledger().cardTotal, why: w.ledger().askWhy };

// ---- 6. what hovering costs over a second of frames at the setting's rate ----
w.setHover(1);
const f0 = w.state.frame, p0 = w.hover().passes;
const t0 = performance.now();
let worst = 0;
while (performance.now() - t0 < 1000) { w.tick(1); await sleep(4); worst = Math.max(worst, w.hover().ms); }
out.hoverOver1s = { passes: w.hover().passes - p0, frames: w.state.frame - f0, worstMs: +worst.toFixed(2) };

await settle(200);
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
