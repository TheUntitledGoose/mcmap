// What each action filter costs the page as BLOCK markers: the look the page chose, the geometry it
// produced, and whether it had to step down. Node-side costs (build/dbg-ghostcost.mjs) say the same
// numbers, but this is the browser allocating the real buffer.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = window.__world;
const out = {};
while (!w.TLAYER.tl) { await sleep(200); }
for (const cls of [1, 2, 3, 0]) {
  w.settings.timeCls = cls;
  w.setTimeLook('blocks');
  w.timeRebuild();
  w.setTimePlay(0);
  w.timeSeekRow(w.TLAYER.quads - 1);
  await sleep(400);
  const t = w.time();
  out[`cls${cls}`] = {
    items: t.quads, drawn: t.drawn, verts: t.verts, look: t.look, want: t.lookWant, why: t.lookWhy,
    posMb: t.markerGeoMb, totalMb: +(t.bytes / 1048576).toFixed(1), capMb: t.geomMbCap,
    buildMs: t.buildMs, fps: Math.round(w.state.fps), worldVerts: w.state.verts, err: t.err,
  };
}
// Same filter, each look, to price the look itself in the page rather than in Node.
w.settings.timeCls = 2;
for (const lk of ['blocks', 'plates', 'tiles']) {
  w.setTimeLook(lk);
  w.timeRebuild();
  w.setTimePlay(0);
  w.timeSeekRow(w.TLAYER.quads - 1);
  await sleep(400);
  const t = w.time();
  out[`look-${lk}`] = {
    items: t.quads, drawn: t.drawn, verts: t.verts,
    look: t.look, posMb: t.markerGeoMb, totalMb: +(t.bytes / 1048576).toFixed(1),
    buildMs: t.buildMs, fps: Math.round(w.state.fps), worldVerts: w.state.verts,
    depthTest: t.depthTest, opacity: t.opacity, polyOffset: t.polyOffset,
  };
}
out.look = w.settings.timeLook;
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
