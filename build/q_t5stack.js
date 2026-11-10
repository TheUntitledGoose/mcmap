// M12b tier 3c: at a voxel this log claims twice (placed, then broken), which claim owns the block you see?
// Parked after the newer claim so both are drawn. The probe finds its OWN stacked voxels in the drawn set and
// ray-tests each, keeping the ones that own their pixel - a ray answers the FRONTMOST marker, so a voxel behind
// the house tests nothing. Reports each claim's box and colour, who is outermost, and what a click answers.
// A/B: add &timestack=0 for the old same-size overlap.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const q = new URLSearchParams(location.search);
const parkAfter = Number(q.get('after') ?? 356000);       // timeline seconds, base-relative
const CAND = Number(q.get('cand') ?? 60);

let tries = 0;
while (!window.__world && tries++ < 100) await sleep(200);
const w = window.__world;
const T = w.TLAYER;
if (!T) { log({ err: 'no TLAYER' }); return; }
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await new Promise(r => requestAnimationFrame(r)); w.tick(2); }
};
await settle(4000);
w.setTimePlay(0);
if (!T.tl) { log({ err: 'timeline never loaded' }); return; }

// Park after the newer claim: the first filter row at/after `parkAfter`, so both claims are drawn.
let lo = 0, hi = T.rows;
while (lo < hi) { const mid = (lo + hi) >> 1; if (T.quadSec[mid] >= parkAfter) hi = mid; else lo = mid + 1; }
w.timeSeekRow(lo);
await settle(3500);

const g = T.mesh.geometry, P = g.attributes.position.array, IX = g.index.array, C = g.attributes.color.array;
const E = T.markerEnd, tl = T.tl;
const ACT = ['change', 'place', 'break', 'insert', 'remove', 'kill', 'other'];
// One key per voxel, in the same cell+packed-coord space the timeline rows use.
const keyOf = (row) => tl.cellOf(row) * 2097152 + ((tl.y(row) + 4096) << 8)
  + ((tl.z(row) & 15) << 4) + (tl.x(row) & 15);

// Pass 1: how many DRAWN claims sit on each voxel, remembering up to 8 of its items.
const at = new Map();
for (let item = 0; item < T.drawn; item++) {
  const row = T.quadRow?.[item];
  if (row === undefined || row < 0) continue;
  const k = keyOf(row);
  const e = at.get(k);
  // Keep the first few claims AND the newest: a voxel here is claimed up to 174 times, and it is the NEWEST
  // claim whose nesting matters.
  if (e) { e.n++; e.last = item; if (e.items.length < 4) e.items.push(item); }
  else at.set(k, { n: 1, items: [item], last: item });
}
// The page's own row -> world mapping, so the probe does not need a second cell table to trust. It takes a
// ROW: an item index is not a row index, and confusing them labeled a voxel 88 blocks from its claims.
const worldOfItem = (item) => w.timeRowWorld(T.quadRow[item]);
const cam = w.camPos();
const cands = [];
for (const [k, e] of at) if (e.n > 1) {
  const v = worldOfItem(e.last);
  if (v) cands.push({ k, n: e.n, items: [...new Set([...e.items, e.last])], voxel: v });
}
cands.sort((a, b) => (Math.max(Math.abs(a.voxel[0] - cam[0]), Math.abs(a.voxel[2] - cam[2]))
  - Math.max(Math.abs(b.voxel[0] - cam[0]), Math.abs(b.voxel[2] - cam[2]))) || (b.n - a.n));

// Pass 2: the geometry of the claims at each candidate, oldest first, so nesting can be read directly.
const claimsAt = (cd) => cd.items.map((item) => {
  const row = T.quadRow[item];
  // A block/plate marker spans a variable index range; a flat tile is one quad = six indices, and the
  // flat look has no markerEnd.
  const from = E ? (item ? E[item - 1] : 0) : item * 6;
  const to = E ? E[item] : (item + 1) * 6;
  const box = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
  let r = 0, gg = 0, n = 0;
  for (let i = from; i < to; i++) {
    const v3 = IX[i] * 3;
    for (let c = 0; c < 3; c++) { box[c] = Math.min(box[c], P[v3 + c]); box[3 + c] = Math.max(box[3 + c], P[v3 + c]); }
    const c4 = IX[i] * 4; r += C[c4]; gg += C[c4 + 1]; n++;
  }
  return { item, row, act: ACT[tl.action[row]], name: tl.nameOf(row), sec: tl.sec[row],
    width: +(box[3] - box[0]).toFixed(3), top: +box[4].toFixed(3),
    red: n ? +(r / n).toFixed(1) : 0, green: n ? +(gg / n).toFixed(1) : 0 };
}).sort((a, b) => a.sec - b.sec);

const tested = [];
for (const cd of cands.slice(0, CAND)) {
  const list = claimsAt(cd);
  const newest = list[list.length - 1];
  const widest = list.slice().sort((a, b) => b.width - a.width)[0];
  const sp = w.screenOf(cd.voxel[0] + 0.5, cd.voxel[1] + 0.5, cd.voxel[2] + 0.5);
  const px = sp && sp.ndcz < 1 && sp.x > 4 && sp.x < innerWidth - 4 && sp.y > 4 && sp.y < innerHeight - 4
    ? [sp.x, sp.y] : null;
  const hit = px ? w.timeHitAt(px[0], px[1]) : null;
  const own = !!(hit && hit.voxel.join(',') === cd.voxel.join(','));
  tested.push({
    voxel: cd.voxel.join(','), claimsDrawn: cd.n, inspected: list.length,
    claimLine: list.map((f) => `${f.act} ${f.name} @${f.sec}s w=${f.width} topY=${f.top} R${f.red} G${f.green}`),
    widthsDiffer: new Set(list.map((f) => f.width)).size === list.length,
    outermostIsNewest: !!(widest && newest && widest.row === newest.row),
    // the flat tile look separates a stack by LIFT, not by size: the later claim sits higher.
    newestIsHighest: !!(newest && list.every((f) => f.top <= newest.top + 1e-4)),
    outermostColour: widest ? (widest.red > widest.green ? 'red' : 'green') : '',
    ownsItsPixel: own,
    whyNot: own ? '' : (hit ? `answered a marker at ${hit.voxel.join(',')}, ${
      Math.max(Math.abs(hit.voxel[0] - cd.voxel[0]), Math.abs(hit.voxel[1] - cd.voxel[1]), Math.abs(hit.voxel[2] - cd.voxel[2]))} blocks off`
      : 'no marker face at that pixel'),
    answeredRow: hit ? hit.row : null,
    answeredIsNewestClaim: !!(hit && newest && hit.row === newest.row),
    answer: hit ? `${ACT[hit.action]} ${tl.nameOf(hit.row)} @${hit.sec}s at ${hit.voxel.join(',')}` : null,
  });
}
const owning = tested.filter((t) => t.ownsItsPixel);
log({
  parkedAtSec: T.sec, look: T.look, drawn: T.drawn, quads: T.quads,
  stackedClaims: w.time().stacked, maxStack: w.time().maxStack, stackRamp: w.time().stackRamp,
  markerGeoMb: w.time().markerGeoMb, fps: Math.round(w.state.fps),
  stackedVoxelsFound: cands.length, rayTested: tested.length, ownsPixel: owning.length,
  voxels: owning.length ? owning : tested,
});
