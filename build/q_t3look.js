// M12b tier 3, measured in the page: does a logged change actually get drawn as its own block?
//
// Same framing as the house screenshots, playhead parked at the end of the filter, and only the LOOK
// changes between frames. Three claims get numbers:
//   the layer reports blocks (or says why it stepped down),
//   the marker mesh really has triangles in the draw range,
//   and switching look moves a lot of pixels - because a cube and a flat plate are different pictures.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); }
};
function frame() {
  w.tick(1);
  const src = w.renderer.domElement;
  const gl = w.renderer.getContext();
  const W = src.width, H = src.height;
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}
const count = (px, pred) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (pred(px[i], px[i + 1], px[i + 2])) n++; return n; };
const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) n++;
  }
  return n;
};
const GREEN = (r, g, b) => g > r + 18 && g > b + 18;
const RED = (r, g, b) => r > g + 18 && r > b + 14;
const back = (px) => count(px, (r, g, b) => Math.abs(r - 0x20) < 6 && Math.abs(g - 0x24) < 6 && Math.abs(b - 0x2b) < 6);

// The same framing as the user's house screenshot, and the time machine armed the way clicking the
// panel checkbox arms it.
w.setTimePlay(0);
w.go(-59, 72, -130);
w.orbit(w.state.yaw, 0.35, 28);
await settle(3000);
if (!w.settings.time) w.set('time', 1);
await settle(4000);

const atEnd = () => { w.timeGoto(w.time().span ?? 0); w.tick(1); };
atEnd();
await settle(1500);
atEnd();

const geoOf = () => {
  let m = null;
  w.scene.traverse((o) => { if (o.isMesh && o.name === 'ledger-time') m = o; });
  if (!m) return { mesh: false };
  const g = m.geometry;
  return {
    mesh: true, visible: m.visible, renderOrder: m.renderOrder,
    verts: g.attributes.position.count,
    indexCount: g.index ? g.index.count : null,
    indexType: g.index ? g.index.array.constructor.name : null,
    drawRange: [g.drawRange.start, g.drawRange.count],
    colorItems: g.attributes.color ? g.attributes.color.itemSize : null,
    hasUv: !!g.attributes.uv,
    mat: { name: m.material.type, map: !!m.material.map, polyOffset: !!m.material.polygonOffset,
      side: m.material.side, opacity: m.material.opacity },
  };
};

const out = { settings: (({ time, timeLook, timeGeomMb, timeCls, ledgerWho, timeTiles, timeTerrain, decalOp }) =>
  ({ time, timeLook, timeGeomMb, timeCls, ledgerWho, timeTiles, timeTerrain, decalOp }))(w.settings) };

out.blocks = { time: w.time(), geo: geoOf() };
const a = frame();
out.blocks.green = count(a, GREEN);
out.blocks.red = count(a, RED);
out.blocks.bg = back(a);

w.setTimeLook('tiles');
await settle(1200);
atEnd();
out.tiles = { time: w.time(), geo: geoOf() };
const b = frame();
out.tiles.green = count(b, GREEN);
out.tiles.red = count(b, RED);
out.tiles.bg = back(b);
out.blocksVsTiles = { changedPixels: diff(a, b), of: a.length / 4, greenDelta: out.blocks.green - out.tiles.green };

w.setTimeLook('plates');
await settle(1200);
atEnd();
out.plates = { time: w.time(), geo: geoOf() };
const c = frame();
out.plates.green = count(c, GREEN);
out.blocksVsPlates = { changedPixels: diff(a, c), of: a.length / 4 };

// Back to what the panel will show, and price a filter change with block markers on.
w.setTimeLook('blocks');
await settle(1200);
const t0 = performance.now();
w.timeRebuild();
out.rebuildMs = +(performance.now() - t0).toFixed(1);
atEnd();
await settle(1500);
out.frames = w.state.frameErrors;
out.pageErrors = (window.__pageErrors ?? []).slice(0, 4);
out.fps = w.state.fps;
out.final = w.time();
return out;
