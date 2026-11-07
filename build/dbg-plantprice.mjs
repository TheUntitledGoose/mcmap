// dbg-plantprice — price the plant / sub-pixel vertex bill before writing any rule for it.
//
// 9.5 measured that 62 % of detail faces cannot join a rectangle, and the cutout pass alone is 45 %
// of all faces. The candidate rule is "a plant plane that covers less than a pixel is not worth four
// corners and six indices". Before writing it, the questions are:
//
//   which shape classes own the detail vertex bill, and what sprites are they?
//   at the framings a person actually uses, how many of those faces are sub-pixel?
//
// It does not reimplement the mesher: it meshes real chunks with the browser mesher, recovers each
// quad's four corners from the emitted stream, classifies the quad by its own geometry (edge lengths
// and normal), and projects it with the same camera the viewer uses (fov 62, pxPerRad = H/(fov*pi/180))
// from the same orbit rig (yaw 0, pitch 8). The detail ring for each framing comes from the shipped
// policy in shared/view.mjs, so "drawn at all" and "sub-pixel" are decided with the real numbers.
//
//   node build/dbg-plantprice.mjs
//   node build/dbg-plantprice.mjs --dist 300 --dist 600 --h 900 --grid 8
//   node build/dbg-plantprice.mjs --caves            # every face, not just lit ones
//   node build/dbg-plantprice.mjs --top 25           # name more sprites
import { readFileSync } from 'node:fs';
import { openChunk } from '../web/js/payload.js';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { stateIndexAt, lightLevelAt, skyLevelAt, sectionIndex } from '../web/js/lookup.js';
import { detailRadius } from '../shared/view.mjs';

// the viewer's own convention: web/js/main.js pxPerRad = canvasHeight / (fov * pi/180)
const pxPerRad = (h = H, fov = FOV) => h / (fov * Math.PI / 180);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const VALUED = ['dim', 'grid', 'dist', 'h', 'pitch', 'top', 'centre', 'radius', 'detailpx'];
const flagVal = (f, d) => { const i = argv.indexOf(`--${f}`); return i < 0 ? d : +argv[i + 1]; };
const flagStr = (f, d) => { const i = argv.indexOf(`--${f}`); return i < 0 ? d : argv[i + 1]; };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUED.includes(argv[i].slice(2))) i++; continue; }
  rest.push(argv[i]);
}
let coords = rest.map((a) => a.split(',').map(Number));
const DIM = flagStr('dim', 'minecraft:overworld');
const DIST = (argv.reduce((a, x, i) => x === '--dist' ? a.concat(+argv[i + 1]) : a, []));
const H = flagVal('h', 900);                 // canvas height in CSS px (draw scale 1)
const PITCH = flagVal('pitch', 8);
const TOP = flagVal('top', 15);
const RADIUS_CEIL = flagVal('radius', 8);    // the shipped close-detail ceiling, in chunks
const DETAIL_PX = flagVal('detailpx', 1);
const FOV = 62;                               // web/js/main.js PerspectiveCamera

const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {});
const geoBuf = readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geoBuf.buffer.slice(geoBuf.byteOffset, geoBuf.byteOffset + geoBuf.byteLength));
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteOffset + b.length);

const [scx, scz] = flagStr('centre', '3,3').split(',').map(Number);
if (!DIST.length) DIST.push(1200, 600, 300, 120);

if (!coords.length) {
  // Sample the area a camera at this framing could actually be showing: the union of the detail rings
  // for every framing asked for. Anything outside it is not drawn at that framing anyway.
  const rings = DIST.map((d) => ringChunks(d));
  const span = Math.max(...rings, 6);
  coords.push([scx, scz]);
  const G = flagVal('grid', 7);
  for (let a = 0; a < G; a++) {
    for (let b = 0; b < G; b++) {
      const dx = Math.round((a - (G - 1) / 2) * span / ((G - 1) / 2));
      const dz = Math.round((b - (G - 1) / 2) * span / ((G - 1) / 2));
      coords.push([scx + dx + ((a * 5 + b * 3) % 3) - 1, scz + dz + ((b * 7 + a * 2) % 3) - 1]);
    }
  }
}

const opts = {
  ao: 1, aoMin: 0.42, lightOn: 1, darkFloor: 0.32, darkGamma: 0.72, skyScale: 1,
  darkcut: has('caves') ? -1 : 0, buried: has('caves') ? 0 : 4, buriedSky: 2,
  surfaceOnly: has('surface') ? 1 : 0,
};

// uv rect -> texture index, so a quad names its own sprite.
const byUV = new Map();
for (let ti = 0; ti < assets.textures.length; ti++) {
  const t = assets.texCell(ti);
  if (t) byUV.set(`${Math.round(t.u0 * 1e6)},${Math.round(t.v0 * 1e6)}`, ti);
}
const texName = (ti) => (ti == null ? '?' : (assets.textures[ti]?.id ?? `#${ti}`));

/** How many chunks of detail the viewer would draw for a camera at `dist`. */
function ringChunks(dist) {
  return detailRadius(dist, pxPerRad(), DETAIL_PX, RADIUS_CEIL);
}

/**
 * Recover one quad's corners from the stream (two triangles, either diagonal). Returns its four
 * corners in block units plus the in-plane edge lengths and the normal, which is all the shape
 * classification needs.
 */
function quadAt(P, U, C, b) {
  const co = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const uu = [0, 0, 0, 0], vv = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const v = b + (i === 3 ? 5 : i);
    co[0][i] = P[v * 3]; co[1][i] = P[v * 3 + 1]; co[2][i] = P[v * 3 + 2];
    uu[i] = U[v * 2]; vv[i] = U[v * 2 + 1];
  }
  const e1 = [co[0][1] - co[0][0], co[1][1] - co[1][0], co[2][1] - co[2][0]];
  const e2 = [co[0][3] - co[0][0], co[1][3] - co[1][0], co[2][3] - co[2][0]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const len = Math.hypot(...n);
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9, rad = 0;
  for (let i = 0; i < 4; i++) {
    x0 = Math.min(x0, co[0][i]); y0 = Math.min(y0, co[1][i]); z0 = Math.min(z0, co[2][i]);
    x1 = Math.max(x1, co[0][i]); y1 = Math.max(y1, co[1][i]); z1 = Math.max(z1, co[2][i]);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
  for (let i = 0; i < 4; i++) {
    rad = Math.max(rad, Math.hypot(co[0][i] - mx, co[1][i] - my, co[2][i] - mz));
  }
  const u0 = Math.min(...uu), v0 = Math.min(...vv);
  return {
    l1: Math.hypot(...e1), l2: Math.hypot(...e2), len, a,
    axis: len > 0.5 && Math.abs(a[0] - len) < 1e-4 ? 0 : (Math.abs(a[1] - len) < 1e-4 ? 1 : (Math.abs(a[2] - len) < 1e-4 ? 2 : -1)),
    mid: [mx, my, mz], rad,
    ti: byUV.get(`${Math.round(u0 * 1e6)},${Math.round(v0 * 1e6)}`),
    area: Math.hypot(e1[0] * e2[1] - e1[1] * e2[0], e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2]),
  };
}

/**
 * Shape class from geometry alone, so it does not depend on block names or on the model bake:
 *   cube      an axis-aligned full-block face - the thing greedy meshing already folds
 *   partial   axis-aligned, but one edge is shorter than a block (slabs, panes, stairs, fence posts)
 *   cross     a vertical plane whose normal is diagonal - the plant cross plane
 *   rotated   any other non-axis-aligned model arm
 *   degenerate zero-area, should not be here
 */
function classOf(q) {
  const unit = Math.abs(q.l1 - 1) < 1e-4 && Math.abs(q.l2 - 1) < 1e-4;
  if (q.axis >= 0) return unit ? 'cube' : 'partial';
  const vertical = Math.abs(q.a[1]) < 1e-3;      // no y in the normal: the plane stands up
  if (vertical && Math.abs(q.a[0] - q.a[2]) < 1e-3) return 'cross';
  return 'rotated';
}

const cls = new Map();           // class -> { quads, area }
const bySprite = new Map();      // sprite id -> { quads, area, cls }
const perPass = [new Map(), new Map(), new Map()];
const quadBank = new Map();      // "cx,cz" -> [{ class, ti, mid, rad, dist }]
let chunksMeshed = 0, meshMs = 0;
for (const [cx, cz] of coords) {
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
  const buf = svc.chunkBytes(DIM, cx, cz);
  if (!buf) continue;
  const map = new Map();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const nb = svc.chunkBytes(DIM, cx + dx, cz + dz);
      if (nb) { const ch = openChunk(ab(nb)); map.set(`${cx + dx},${cz + dz}`, { ch, secOf: sectionIndex(ch) }); }
    }
  }
  const me = map.get(`${cx},${cz}`);
  if (!me) continue;
  const getCh = (x, z) => map.get(`${x},${z}`);
  const at = (ccx, ccz, lx, ly, lz) => stateIndexAt(getCh, ccx, ccz, lx, ly, lz, assets.states.length);
  const o = { ...opts };
  o.light = (x, z, lx, ly, lz) => lightLevelAt(getCh, x, z, lx, ly, lz, 1);
  o.sky = (x, z, lx, ly, lz) => skyLevelAt(getCh, x, z, lx, ly, lz, 1);
  const t0 = performance.now();
  const { streams } = meshChunk(assets, me.ch, at, o);
  meshMs += performance.now() - t0;
  chunksMeshed++;
  const bank = [];
  streams.forEach((s, pass) => {
    if (!s.count) return;
    for (let q = 0, n = s.count / 6; q < n; q++) {
      const qq = quadAt(s.position, s.uv, s.color, q * 6);
      const k = classOf(qq);
      if (!cls.has(k)) cls.set(k, { quads: 0, verts: 0, area: 0 });
      const c = cls.get(k);
      c.quads++; c.area += qq.area;
      if (!perPass[pass].has(k)) perPass[pass].set(k, 0);
      perPass[pass].set(k, perPass[pass].get(k) + 1);
      const sn = texName(qq.ti);
      if (!bySprite.has(sn)) bySprite.set(sn, { quads: 0, area: 0, k, cross: 0, rotated: 0, partial: 0 });
      const bs = bySprite.get(sn);
      bs.quads++; bs.area += qq.area; bs[k] = (bs[k] || 0) + 1;
      bank.push({ k, mid: [cx * 16 + qq.mid[0], qq.mid[1], cz * 16 + qq.mid[2]], rad: qq.rad, area: qq.area, pass });
    }
  });
  quadBank.set(`${cx},${cz}`, bank);
}

// --- project every banked quad for each framing -------------------------------------------
const f = (x) => Math.round(x).toLocaleString('en-US');
const pct = (a, b) => (100 * a / Math.max(1, b)).toFixed(1);
const totalQuads = [...cls.values()].reduce((s, c) => s + c.quads, 0);
console.log(`${chunksMeshed} chunks meshed (${meshMs.toFixed(0)} ms), ${f(totalQuads)} quads, settings ${JSON.stringify(opts)}`);

let tq = 0, ta = 0;
for (const [k, c] of [...cls.entries()].sort((a, b) => b[1].quads - a[1].quads)) { tq += c.quads; ta += c.area; }
console.log('\nshape class share of the detail bill');
console.log('  class      quads   % quads   % of face area   soup verts/chunk   indexed verts+idx/chunk');
for (const [k, c] of [...cls.entries()].sort((a, b) => b[1].quads - a[1].quads)) {
  const qpc = c.quads / chunksMeshed;
  console.log(`  ${k.padEnd(10)}${f(c.quads).padStart(7)}  ${pct(c.quads, totalQuads).padStart(5)}   `
    + `${pct(c.area, ta).padStart(5)}             ${qpc.toFixed(0).padStart(6)}`
    + `                 ${(qpc * 4).toFixed(0)}+${(qpc * 6).toFixed(0)}`);
}
console.log('\nper pass (0 opaque, 1 cutout, 2 translucent)');
perPass.forEach((m, pass) => {
  const tot = [...m.values()].reduce((s, v) => s + v, 0);
  const parts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, tot)}%`);
  console.log(`  pass ${pass}: ${f(tot)} quads  ${parts.join(' ')}`);
});

const common = [...bySprite.entries()].sort((a, b) => b[1].quads - a[1].quads).slice(0, TOP);
console.log(`\nthe ${TOP} commonest sprites in the detail bill (quads, % of quads, class mix)`);
for (const [sn, b] of common) {
  const mix = ['cube', 'partial', 'cross', 'rotated'].filter((k) => b[k]).map((k) => `${k} ${b[k]}`).join(' ');
  console.log(`  ${String(pct(b.quads, totalQuads)).padStart(5)}%  ${sn.padEnd(46)} ${mix}`);
}

console.log('\nsub-pixel bill at real framings (canvas height ' + H + ' px, fov ' + FOV + ', pitch ' + PITCH + ' deg)');
for (const dist of DIST) {
  const ring = ringChunks(dist);
  const ppr = pxPerRad();
  const p = PITCH * Math.PI / 180;
  const tx = scx * 16 + 8, tz = scz * 16 + 8, ty = 127;
  const eye = [tx, ty + Math.sin(p) * dist, tz + Math.cos(p) * dist];
  let drawn = 0, sub = 0, subCls = new Map(), drawnCls = new Map();
  for (const [key, bank] of quadBank) {
    const [cx, cz] = key.split(',').map(Number);
    if (Math.max(Math.abs(cx - scx), Math.abs(cz - scz)) > ring) continue;   // not drawn at this framing
    for (const q of bank) {
      const d = Math.hypot(q.mid[0] - eye[0], q.mid[1] - eye[1], q.mid[2] - eye[2]);
      const px = 2 * q.rad * ppr / Math.max(1, d);   // longest dimension, in pixels
      drawn++;
      drawnCls.set(q.k, (drawnCls.get(q.k) || 0) + 1);
      if (px < 1) { sub++; subCls.set(q.k, (subCls.get(q.k) || 0) + 1); }
    }
  }
  const parts = [...drawnCls.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${pct(subCls.get(k) || 0, v)}% sub-pixel of ${f(v)}`);
  console.log(`  dist ${String(dist).padStart(4)} m  detail ring ${ring} chunks (${ring * 16} m)  drawn ${f(drawn)} quads`
    + `  sub-pixel ${f(sub)} (${pct(sub, drawn)}% of quads, ${pct(sub * 4, drawn * 4)}% of indexed verts)`);
  console.log(`      ${parts.join('   ')}`);
}
