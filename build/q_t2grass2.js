// 12b.5: the pixel proof for the block-change class, on a voxel this probe first checks is visible.
//
// Two earlier attempts measured 0 changed pixels because they framed changes that were buried (a trampled
// block under polished diorite) or framed a wide view where the sharp layer barely covers the screen.
// `build/dbg-changerow.mjs` searched the timeline for changes that are the TOP block of their column AND
// whose after-name matches what the payload holds today, so undoing one must repaint it: -236,77,137 was
// grass_block when the log caught it and is dirt today.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 300) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
const out = {};
await sleep(0);                                   // browser-probe wraps a probe in an async IIFE only if it sees await

const VX = -236, VY = 77, VZ = 137;               // the candidate from dbg-changerow.mjs
w.go(VX + 0.5, VY + 1, VZ + 0.5);
w.orbit(0.6, 0.55, 14);
// The filter comes from the URL (`?timecls=1`), not from here: writing `settings.timeCls` does not
// rebuild the row filter, so the layer would keep the places rows it booted with and the undo would be
// asked to undo rows it never selected. `__world.timeRebuild()` is the honest way to change it live.
w.settings.timeTiles = 0;                          // no decal: any pixel that moves is a block
w.timeSeekRow(0);                                  // before every logged change
await settle();                                  // load and mesh the ring first: marking chunks that are not
                                                 // held yet would measure a hole, not an undo
out.settings = { cls: w.settings.timeCls, tiles: w.settings.timeTiles, who: w.settings.ledgerWho,
  limit: w.settings.timeTerrainLimit, playhead: w.time().at, detailVerts: w.state.detailVerts };

// Is the camera actually on that block? `pickState` answers with the block the ray hits, which is the
// only way to know the frame contains the thing being measured.
const mid = () => { w.tick(1); return w.pickState(innerWidth / 2, innerHeight / 2); };

const crop = (buf, gw, gh, x0, y0, wv, hv) => {
  // GL rows start at the bottom; the crop is a box around the screen centre.
  const px = Math.floor((innerWidth / 2 + x0) * (gw / innerWidth));
  const py = Math.floor((innerHeight / 2 - y0) * (gh / innerHeight));
  const cw = Math.round(wv * (gw / innerWidth)), chh = Math.round(hv * (gh / innerHeight));
  const o = new Uint8Array(cw * chh * 4);
  for (let j = 0; j < chh; j++) {
    const src = ((py - j) * gw + px) * 4, dst = j * cw * 4;
    o.set(buf.subarray(src, src + cw * 4), dst);
  }
  return o;
};

const grab = () => { w.tick(1); const g = w.grab(); return { b: g.buf, w: g.w, h: g.h }; };

w.settings.timeTerrain = 1; w.histSync(true);
await settle();
out.pickOn = mid();
const A = grab();
out.on = { ...w.histStats(), totals: w.histTotals(), verts: w.state.detailVerts };

w.settings.timeTerrain = 0; w.histSync(true);
await settle();
out.pickOff = mid();
const B = grab();
out.off = { ...w.histStats(), totals: w.histTotals(), verts: w.state.detailVerts };

const ca = crop(A.b, A.w, A.h, -160, -120, 320, 240);
const cb = crop(B.b, B.w, B.h, -160, -120, 320, 240);
let changed = 0, green = 0, dirt = 0;
for (let i = 0; i < ca.length; i += 4) {
  const d = Math.abs(ca[i] - cb[i]) + Math.abs(ca[i + 1] - cb[i + 1]) + Math.abs(ca[i + 2] - cb[i + 2]);
  if (d > 20) changed++;
  if (ca[i + 1] > 110 && ca[i + 1] > ca[i] + 18) green++;      // green under undo
  if (cb[i + 1] > 110 && cb[i + 1] > cb[i] + 18) dirt++;       // green with today
}
out.pixels = { cropPx: ca.length / 4, changed, greenOn: green, greenOff: dirt,
  wholeFrameChanged: (() => { let n = 0; for (let i = 0; i < Math.min(A.b.length, B.b.length); i += 4) {
    if (Math.abs(A.b[i] - B.b[i]) + Math.abs(A.b[i + 1] - B.b[i + 1]) + Math.abs(A.b[i + 2] - B.b[i + 2]) > 20) n++;
  } return n; })() };

w.settings.timeTerrain = 1; w.histSync(true);      // leave the page in the undone state for the screenshot
out.note = w.histNote();
out.errors = { page: w.state.bootError ?? null, frames: w.state.frameErrors ?? 0 };
return out;
