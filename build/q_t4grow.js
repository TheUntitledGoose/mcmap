// Does a logged change read as a block, and how far does the BLOCK half of the time machine reach?
//
// Run once per URL; the A/B is the URL, not this file. It measures:
//  * marker solidity, in WORLD BLOCKS (the mesher works in blocks, so a marker's faces should stand
//    ~0.09 blocks outside the voxel it claims - the fix for "I see the green 2D tile but no block");
//  * timeSplit(): how many drawn changes stand in a chunk whose blocks the replay actually re-cuts;
//  * frames, verts and payload radius, so the raised replay ceiling (?timesharp=) has a price;
//  * the panel's own sentence, which is what the viewer sees.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
// rAF-based settle: a sleep(25)+tick loop starves the mesh workers during a pan/seek, and the numbers
// that come out of a starved pool describe a page that does not exist.
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await new Promise((r) => requestAnimationFrame(r));
    w.tick(2);
  }
};
const S = w.settings;
w.setTimePlay(0);
await settle(1200);
w.timeSeekRow(Math.round((w.TLAYER.quads || 1) * 0.31));
await settle(3000);

const out = {};
out.settings = { radius: S.radius, timeSharp: S.timeSharp, timeGrow: S.timeGrow, timeLook: S.timeLook,
  timeTerrain: S.timeTerrain, timeTiles: S.timeTiles, timeCls: S.timeCls, who: S.ledgerWho };
const st = w.state;
out.frame = { dist: st.dist, detailRadius: st.detailRadius, detailMeshes: st.detailMeshes,
  payloadRadius: st.payloadRadius, detailVerts: st.detailVerts, verts: st.verts };

// Marker solidity, in blocks: how far the drawn faces stand outside the voxel they claim, and how many
// different voxels a single marker's own corners fall in (a flat tile spans one voxel, a cube spans 8).
function markerShape(limit = 40) {
  const g = w.TLAYER.mesh && w.TLAYER.mesh.geometry;
  const P = g && g.attributes.position.array, IX = g && g.index && g.index.array;
  const E = w.TLAYER.markerEnd;
  if (!P || !IX || !E || !E.length) return { n: 0, why: 'no indexed marker mesh' };
  const rows = [];
  for (let m = 0; m < Math.min(limit, E.length); m++) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let j = (m ? E[m - 1] : 0); j < E[m]; j++) {
      const o = IX[j] * 3;
      for (let k = 0; k < 3; k++) {
        const v = P[o + k];
        if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
      }
    }
    // A grown cube is centred on the block it describes, so the block comes from the centre.
    const bx = Math.round((lo[0] + hi[0]) / 2 - 0.5);
    const by = Math.round((lo[1] + hi[1]) / 2 - 0.5);
    const bz = Math.round((lo[2] + hi[2]) / 2 - 0.5);
    const vox = new Set();
    for (let j = (m ? E[m - 1] : 0); j < E[m]; j++) {
      const o = IX[j] * 3;
      vox.add(`${Math.floor(P[o])},${Math.floor(P[o + 1])},${Math.floor(P[o + 2])}`);
    }
    rows.push({
      voxel: [bx, by, bz],
      // how far the drawn faces stand OUTSIDE the voxel it claims, in blocks: 0 means flush (a tinted
      // square on the block's own skin), 0.09 means the marker wraps the block visibly
      outside: +(Math.max(hi[0] - (bx + 1), bx - lo[0], hi[1] - (by + 1), by - lo[1],
        hi[2] - (bz + 1), bz - lo[2])).toFixed(4),
      // 8 voxels = one solid cube; 1 = a flat plate; more = a model that spans neighbours
      cornerVoxels: vox.size,
    });
  }
  const med = (arr) => arr.slice().sort((x, y) => x - y)[arr.length >> 1];
  return { n: rows.length, medianOutside: med(rows.map((r) => r.outside)),
    medianCornerVoxels: med(rows.map((r) => r.cornerVoxels)), sample: rows.slice(0, 3) };
}
out.marker = markerShape();

// How far the block half reaches, straight from the page.
out.split = w.timeSplit();
out.hist = w.histTotals();
out.time = { drawn: w.TLAYER.drawn, quads: w.TLAYER.quads, look: w.TLAYER.look, why: w.TLAYER.lookWhy };
out.note = w.histNote().replace(/\n/g, ' | ');

// A raised detail ceiling does not show up as a slower steady frame first: it shows up as longer WORK
// (625 chunks to mesh instead of 289). So measure both: how long the page takes to go quiet, and the frame
// rate once it is quiet. An fps taken during work describes a page that is still building, not a view.
async function quiet(capMs = 25000) {
  const t0 = performance.now();
  for (;;) {
    await new Promise((r) => requestAnimationFrame(r));
    w.tick(2);
    const s = w.state;
    if (!s.queued && !s.inflight && !s.dirty && (!s.ringStuck || s.ringStuck.length === 0)) break;
    if (performance.now() - t0 > capMs) break;
  }
  return Math.round(performance.now() - t0);
}
out.msToQuiet = await quiet();
const t0 = performance.now();
let f = 0;
while (performance.now() - t0 < 2000) { await new Promise((r) => requestAnimationFrame(r)); w.tick(2); f++; }
out.fpsSettled2s = +(f / 2).toFixed(1);
out.vertsAfter = w.state.verts;
out.quietFrame = { detailMeshes: w.state.detailMeshes, detailVerts: w.state.detailVerts,
  verts: w.state.verts, chunks: w.state.chunks };
out.splitSettled = w.timeSplit();
out.histSettled = w.histTotals();
out.noteSettled = w.histNote().split(String.fromCharCode(10)).join(' | ');
console.log(JSON.stringify(out, null, 1));
