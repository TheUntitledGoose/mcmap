// The path a viewer actually takes: open the page with no parameters, tick "time machine", move the thumb.
// No ?time=1, no probe-only switches - the panel setter, the way a click reaches it. The count is drawn
// vertices inside the house's own box (chunk -4,-9, y 66..92), which is the only instrument that answers
// "did the building change on screen".
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
w.go(-59, 72, -130);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3500);

const EPS = 1e-3, BX0 = -64, BX1 = -48, BZ0 = -144, BZ1 = -128, BY0 = 66, BY1 = 92;
function boxCorners() {
  let n = 0, meshes = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry || !/^detail/.test(o.name || '')) return;
    const g = o.geometry, pa = g.attributes.position;
    if (!pa) return;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    if (bb.max.x < BX0 - EPS || bb.min.x > BX1 + EPS || bb.max.z < BZ0 - EPS || bb.min.z > BZ1 + EPS
      || bb.max.y < BY0 - EPS || bb.min.y > BY1 + EPS) return;
    const p = pa.array;
    let h = 0;
    for (let v = 0, m = pa.count; v < m; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (x < BX0 - EPS || x > BX1 + EPS || z < BZ0 - EPS || z > BZ1 + EPS || y < BY0 - EPS || y > BY1 + EPS) continue;
      h++;
    }
    if (h) { n += h; meshes++; }
  });
  return { n, meshes };
}
function dupCount() {
  const seen = new Set();
  let dup = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || o.name !== 'detail0' || !o.visible || !o.geometry) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const k = [g.boundingBox.min.x, g.boundingBox.min.z, g.boundingBox.max.x, g.boundingBox.max.z].join(',');
    if (seen.has(k)) dup++; else seen.add(k);
  });
  return dup;
}

const out = { tickedTimeMachineWith: { terrain: w.histWanted() ? 1 : 0 }, before: boxCorners(), dupBefore: dupCount() };

// the click
const ok = w.set('time', 1);
await settle(5000);                                  // timeline fetch + filter + one mesh build
out.afterTick = {
  setTime: ok, time: w.time().on, terrain: w.histWanted() ? 1 : 0, rows: w.time().rows,
  tilesOn: w.settings.timeTiles, err: w.time().err, corners: boxCorners().n, dup: dupCount(),
};

const rows = w.time().rows;
w.timeSeekRow(rows - 1); w.histSync(true); await settle(4000);
const end = boxCorners();
const hEnd = w.histStats();
const vertsEnd = w.state.detailVerts;

w.timeSeekRow(0); w.histSync(true); await settle(5000);
const start = boxCorners();
const hStart = w.histStats();

out.houseBoxCorners = { present: out.before.n, atEndOfLog: end.n, atStartOfLog: start.n };
out.histAtEnd = { chunks: hEnd.chunks, edits: hEnd.edits, marked: hEnd.marked, restore: hEnd.restore, capped: hEnd.capped, builds: hEnd.builds, syncMs: hEnd.syncMs };
out.histAtStart = { chunks: hStart.chunks, edits: hStart.edits, marked: hStart.marked, restore: hStart.restore, capped: hStart.capped, builds: hStart.builds, syncMs: hStart.syncMs, note: w.histNote().slice(0, 160) };
out.dup = { before: out.dupBefore, end: dupCount(), start: dupCount() };
out.detailVerts = { end: vertsEnd, start: w.state.detailVerts };
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
