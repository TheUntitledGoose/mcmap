// M12b tier 3, the path a person actually takes on a settled page: the time machine is armed and has
// played out, the outline sits on a drawn change, and a click on that change asks the ledger about THAT
// voxel. No parameters but the camera and `?time=1`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const w = window.__world;
const settle = async (ms = 3000) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
const txt = () => {
  const c = document.querySelector('.lcard');
  return c ? c.textContent.replace(/\s+/g, ' ').slice(0, 170) : '(no card)';
};

out.settings = { time: w.settings.time, look: w.settings.timeLook, tiles: w.settings.timeTiles,
  terrain: w.settings.timeTerrain, hover: w.settings.hover, playTouched: w.settings.playTouched };
const armT0 = performance.now();
while ((!w.TLAYER.quads || w.TLAYER.drawn < w.TLAYER.quads) && performance.now() - armT0 < 30000) {
  await sleep(200);
}
const end = w.time();
out.atEnd = { drawn: end.drawn, items: end.quads, verts: end.verts, look: end.look, err: end.err,
  markerGeoMb: end.markerGeoMb, indexBytes: end.bytes - end.kb * 1024, depthTest: end.depthTest,
  opacity: end.opacity, polyOffset: end.polyOffset, drawRange: end.drawRange, playing: end.playing };

// 1. FIND a drawn marker near the middle of the view, and check the ANSWER against the pixel it was
// aimed at rather than against the row the probe hoped to see.
const probe = w.timeHitProbe(0);
out.markerProbe = probe.ok
  ? { ok: 1, aimed: probe.probe, expectsRow: probe.expects, voxel: probe.voxel, dist: probe.distance,
      answersRow: probe.hit?.row, sameRow: probe.same, hitVoxel: probe.hit?.voxel,
      hitPixel: probe.hitPixel, offPx: probe.offPx, hitDrawn: probe.hitDrawn, rayMs: +w.TLAYER.hitMs.toFixed(1) }
  : { ok: 0, why: probe.why, drawn: probe.drawn, expects: probe.expects };

// 2. THE OUTLINE on that voxel: the pick is a ray over the world (17-27 ms here), the "is a drawn change
// sitting on this voxel?" part is two Map lookups.
out.cheapLookup = probe.voxel ? w.timeDrawnAt(probe.voxel[0], probe.voxel[1], probe.voxel[2]) : null;
w.setHover(1);
const aim0 = probe.ok ? probe.probe : [Math.round(innerWidth / 2), Math.round(innerHeight / 2)];
out.hoverOnPoint = w.hoverAt(aim0[0], aim0[1]);
const outlineOn = { ...w.hover() };
const a = w.grab();
w.setHover(0); w.tick(2); await settle(300);
const b = w.grab();
w.setHover(1); w.tick(2); await settle(300);
let changed = 0, maxDelta = 0;
const box = [1e9, 1e9, -1e9, -1e9];
for (let i = 0; i < a.buf.length; i += 4) {
  const d = Math.max(Math.abs(a.buf[i] - b.buf[i]), Math.abs(a.buf[i + 1] - b.buf[i + 1]),
    Math.abs(a.buf[i + 2] - b.buf[i + 2]));
  if (d > 12) {
    changed++;
    if (d > maxDelta) maxDelta = d;
    const px = (i / 4) % a.w, py = Math.floor((i / 4) / a.w);
    box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py);
    box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py);
  }
}
out.outlinePixels = { changed, of: a.buf.length / 4, box, maxDelta, outlineOn: { at: outlineOn.at, changes: outlineOn.changes } };

// 3. IDLE: a hover with nothing to re-pick must cost nothing. Zero the counters first, or "passes 1,
// skips 393" is a lifetime count wearing an idle label.
const life = w.hover();
const idle0 = w.hoverReset();
await settle(1000);
out.idle = { window: { passes: w.hover().passes, skips: w.hover().skips, why: w.hover().why,
  setting: w.hover().setting, everyMs: w.hover().everyMs },
  lifetime: { passes: life.passes, skips: life.skips, resetTo: idle0.passes } };

// 4. CLICK the marker, then read what the wire said and not just the sentence drawn over the card.
const aim = aim0;
const asked = await w.askAt(aim[0], aim[1]);
await settle(500);
out.click = { aimedPixel: aim, why: w.ledger().askWhy, card: asked, wire: w.ledger().lastAsk, text: txt() };

// 5. T on the middle of the view: same near answer, this time about the block under the crosshair.
w.ledgerAskCentre();
await settle(500);
out.keyT = { asks: w.ledger().asks, why: w.ledger().askWhy, wire: w.ledger().lastAsk, text: txt() };

// 6. The card row a click came from, and where that row says the change is.
out.rowWorld = probe.ok && probe.hit ? w.timeRowWorld(probe.hit.row) : null;
out.state = { verts: w.state.verts, chunks: w.state.chunks, fps: w.state.fps };
out.hist = { ...w.hist(), ...w.histStats() };
out.pageErrors = [w.state.bootError, w.state.frameError].filter(Boolean);
return out;
