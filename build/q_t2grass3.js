// 12b.5: the pixel proof, aimed from the page's own edit list.
//
// Two earlier attempts framed a change that was buried, and a third framed a change the camera did not
// contain: the undo was real (510 voxels across 13 chunks, detail verts 4,468,072 vs 4,467,344) and the
// whole frame was still pixel-identical, because the changed voxels sat off screen. So ask the page which
// voxels it is about to rewrite, stand on one of them, and only then compare frames.
//
// URL must carry `?timecls=1`: the row filter is built at boot / by `timeRebuild()`, so assigning
// `settings.timeCls` here would leave the layer filtered to places.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 260) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
const out = {};
await sleep(0);                                   // browser-probe wraps a probe in an async IIFE only if it sees await

// The time machine auto-plays, and at 20,000 changes per wall-clock second the cursor reaches the end of
// the filtered rows in a fraction of a second. That is what made three earlier A/B probes read "0 pixels
// changed": by the time the second frame was grabbed, the playhead had run out and both sides showed
// today. Stop the clock and pin the cursor before every measurement.
w.setTimePlay(0);
w.settings.timeTiles = 0;                         // no decal: any pixel that moves is a block
w.timeSeekRow(0);                                 // before every logged change: undo them all
w.settings.timeTerrain = 1;
w.histSync(true);
await settle();

// The chunk under the camera, and one of the voxels the log is about to rewrite there. `edits` is an
// Int32Array of [packedCoord, stateId] pairs with the same coordinate packing the timeline uses:
// x in the low 4 bits, z in the next 4, y + 4096 above that.
const [ccx, ccz] = [Math.floor(-236 / 16), Math.floor(137 / 16)];
const m = w.histEditsOf(ccx, ccz);
out.mark = m ? { stamp: m.stamp, edits: m.edits.length / 2, changeRows: m.changeRows, unknown: m.unknown } : null;
if (!m || !m.edits.length) { out.found = 0; return out; }

let pick = null;
for (let i = 0; i < m.edits.length && !pick; i += 2) {
  const c = m.edits[i], state = m.edits[i + 1];
  const x = ccx * 16 + (c & 15), z = ccz * 16 + ((c >> 4) & 15), y = ((c >> 8) & 0x1fff) - 4096;
  const up1 = w.at(x, y + 1, z), up3 = w.at(x, y + 3, z);
  if (!up1 || up1 !== up3) continue;              // needs air above, twice over: a buried edit paints nothing
  pick = { x, y, z, state, stamp: m.stamp };
}
out.pick = pick;
if (!pick) { out.found = 0; return out; }

w.go(pick.x + 0.5, pick.y + 0.5, pick.z + 0.5);
w.orbit(0.6, 0.5, 10);
await settle();
w.histSync(true);                                  // re-mark now that the ring moved onto this voxel
await settle();
out.on = { ...(w.histStats() || {}), totals: w.histTotals(), verts: w.state.detailVerts };
const grab = () => { w.tick(1); const g = w.grab(); return { b: g.buf, w: g.w, h: g.h }; };
w.timeSeekRow(0); await settle(30);
out.curBeforeA = w.time().cur; out.secBeforeA = w.time().sec;
const A = grab();

w.settings.timeTerrain = 0;
w.histSync(true);
await settle();
out.off = { ...(w.histStats() || {}), totals: w.histTotals(), verts: w.state.detailVerts };
w.timeSeekRow(0); await settle(30);
out.curBeforeB = w.time().cur; out.secBeforeB = w.time().sec;
const B = grab();

const count = (a, b, thr) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) {
  if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > thr) n++; } return n; };
out.pixels = { changed20: count(A.b, B.b, 20), changed60: count(A.b, B.b, 60), framePx: A.b.length / 4,
  vertsOn: out.on.verts, vertsOff: out.off.verts };

w.settings.timeTerrain = 1; w.histSync(true); await settle(60);   // leave the page in the undone state
out.errors = { page: w.state.bootError ?? null, frames: w.state.frameErrors ?? 0 };
return out;
