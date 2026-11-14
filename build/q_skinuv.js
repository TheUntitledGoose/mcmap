// Why is a skinned body white? The people layer's own numbers, not a guess:
//   - the people mesh's groups (which triangles take the skinned materials) and the UV range of those
//     triangles, which says which strip column they read,
//   - the strip texture attached to those materials, and what the strip actually holds at the texels a
//     head-front-centre should read (a 2D canvas decode of the same PNG the page fetched),
//   - the framebuffer colour at that head.
// The frame said white [255,255,255]; the question is whether the texels are white or the read is wrong.
const w = __world; const raf = () => new Promise((r) => requestAnimationFrame(r));
const say = (k, v) => console.log(`UV ${k} ${JSON.stringify(v)}`);
const P = new URLSearchParams(location.search);
const settle = async (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await raf(); await raf(); } };
for (let i = 0; i < 40; i++) await raf();
const T = +(P.get('tsec') || 0);
w.seekSec(T); if (w.setTimePlay) w.setTimePlay(0); w.ghostApply(T);
await settle(1200);
const g = w.ghosts();
say('skins', w.skins());
say('bodies', g.bodies.filter((b) => b.x != null).map((b) => ({ p: b.player, at: [b.x, b.y, b.z], skinned: b.skinned, slim: b.slim, seen: b.seen })));

let mesh = null;
w.scene.traverse((o) => { if (Array.isArray(o.material) && o.material.length === 4) mesh = o; });
if (!mesh) { say('mesh', 'no 4-material people mesh in the scene'); throw new Error('nomesh'); }
const geo = mesh.geometry;
const uv = geo.attributes.uv, pos = geo.attributes.position;
say('mesh', { verts: pos.count, hasUv: !!uv, groups: (geo.groups || []).map((q) => [q.start, q.count, q.materialIndex]) });
say('mats', mesh.material.map((m, i) => ({
  i, type: m.type, alphaTest: m.alphaTest, vertexColors: !!m.vertexColors,
  map: m.map ? { w: m.map.image.width, h: m.map.image.height, flipY: m.map.flipY, wrapS: m.map.wrapS, wrapT: m.map.wrapT, colorSpace: m.map.colorSpace } : null,
})));
// UV range of the triangles that take each material, and the colour of the vertices there.
const col = geo.attributes.color;
const rng = {};
for (const q of geo.groups || []) {
  const r = (rng[q.materialIndex] = rng[q.materialIndex] || { u0: 9, u1: -9, v0: 9, v1: -9, n: 0, col: [9, 9, 9], colMax: [-9, -9, -9] });
  for (let i = q.start; i < q.start + q.count; i++) {
    if (!uv) break;
    r.u0 = Math.min(r.u0, uv.getX(i)); r.u1 = Math.max(r.u1, uv.getX(i));
    r.v0 = Math.min(r.v0, uv.getY(i)); r.v1 = Math.max(r.v1, uv.getY(i));
    r.n++;
    if (col) for (let c = 0; c < 3; c++) { r.col[c] = Math.min(r.col[c], col.getY ? col.getComponent(i, c) : 0); r.colMax[c] = Math.max(r.colMax[c], col.getComponent(i, c)); }
  }
}
say('uvByMaterial', Object.fromEntries(Object.entries(rng).map(([k, r]) => [k, {
  tris: r.n, u: [+r.u0.toFixed(3), +r.u1.toFixed(3)], v: [+r.v0.toFixed(3), +r.v1.toFixed(3)],
  col: r.col.map((v) => +v.toFixed(2)), colMax: r.colMax.map((v) => +v.toFixed(2)),
}])));

// What the strip itself says at the texels a head-front-centre reads. head uv [0,0], front rect [8,8,16,16].
const j = await (await fetch('/skins/strip.json')).json();
const img = new Image();
await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = '/skins/strip.png?probe=' + Date.now(); });
const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
const cx2 = cv.getContext('2d'); cx2.drawImage(img, 0, 0);
const cell = j.cell, cols = {};
for (const c of j.cells) {
  if (c.white) { cols[c.column] = 'white cell'; continue; }
  const d = cx2.getImageData(c.column * cell + 12, 12, 1, 1).data;   // head front centre
  cols[c.column] = { name: c.name, headFront: [d[0], d[1], d[2], d[3]] };
}
say('strip', { columns: j.columns, cell, white: j.white, imgW: img.width, imgH: img.height, cols });

// The framebuffer at the head of a skinned body.
const b = g.bodies.find((x) => x.x != null && x.skinned) || g.bodies.find((x) => x.x != null);
if (b) {
  const [hx, hy] = w.project(b.x + 0.5, b.y + 1.75, b.z + 0.5);
  const f = w.grab();
  const gx = Math.floor((hx + 0.5) * f.dpr), gy = Math.floor((innerHeight - hy - 0.5) * f.dpr);
  const px = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const i = ((gy + dy) * f.w + (gx + dx)) * 4;
    px.push([f.buf[i], f.buf[i + 1], f.buf[i + 2]]);
  }
  say('headPx', { body: [b.x, b.y, b.z], p: b.player, at: [Math.round(hx), Math.round(hy)], px });
  const [cxp, cyp] = w.project(b.x + 0.5, b.y + 1.0, b.z + 0.5);
  const i = ((Math.floor((innerHeight - cyp - 0.5) * f.dpr) * f.w) + Math.floor((cxp + 0.5) * f.dpr)) * 4;
  say('chestPx', [f.buf[i], f.buf[i + 1], f.buf[i + 2]]);
}
