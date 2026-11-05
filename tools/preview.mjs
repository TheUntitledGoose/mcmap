// Baked-geometry contact sheet: rasterises selected block states with a tiny software renderer so
// the bake (winding, uv, rotations, cullface handling) can be eyeballed without a browser.
//   node tools/preview.mjs [--filter regex] [--out build/preview.png] [--cols 8] [--cell 96]
// With no --filter it draws a hand-picked set that exercises every interesting path.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePngRgba } from '../server/png.mjs';
import { CANON_RING, decodeFaceCode, cubeFaceUV } from '../shared/cube-path.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const ASSET = arg('assets', 'build/assets');
const OUT = arg('out', 'build/preview.png');
const COLS = Number(arg('cols', 8));
const CELL = Number(arg('cell', 110));

const atlas = JSON.parse(fs.readFileSync(path.join(ASSET, 'atlas.json'), 'utf8'));
const png = decodePng(fs.readFileSync(path.join(ASSET, 'atlas.png')));
const bin = fs.readFileSync(path.join(ASSET, 'geometry.bin'));
const geoms = bin.readUInt32LE(8), quads = bin.readUInt32LE(12), posScale = bin.readUInt32LE(16); // units per block
const POS = 32, UV = POS + geoms * 24, REF = UV + geoms * 16;
if (bin.length !== REF + quads * 8) throw new Error('geometry.bin truncated');

const DEFAULT_SET = [
  'minecraft:stone', 'minecraft:grass_block|snowy=false', 'minecraft:dirt', 'minecraft:oak_planks',
  'minecraft:oak_stairs|facing=east,half=bottom,shape=straight,waterlogged=false',
  'minecraft:oak_fence|east=false,north=false,south=true,waterlogged=false,west=false',
  'minecraft:glass', 'minecraft:water|level=0', 'minecraft:oak_leaves|distance=1,persistent=false,waterlogged=false',
  'minecraft:grass', 'minecraft:torch', 'minecraft:redstone_wire|east=none,north=none,power=0,south=none,west=none',
  'minecraft:chest|facing=north,type=single,waterlogged=false', 'minecraft:anvil|facing=north',
  'minecraft:glow_lichen|down=false,east=false,north=false,south=false,up=true,waterlogged=false,west=false',
  'minecraft:bookshelf', 'minecraft:crafting_table', 'minecraft:furnace|facing=north,lit=false',
  'minecraft:cactus|age=0', 'minecraft:snow|layers=2', 'minecraft:red_mushroom',
  'minecraft:end_rod|facing=up', 'minecraft:lantern|hanging=false,waterlogged=false',
  'minecraft:composter|level=0',
  'regions_unexplored:elephant_ear|half=lower', 'regions_unexplored:dropleaf|age=24',
  'regions_unexplored:medium_grass', 'darkblades:dark_ore', 'clutter:cattails|half=lower,waterlogged=true',
  'geode_plus:budding_redstone|lit=false', 'lootr:lootr_barrel|facing=south,open=false',
  'croptopia:strawberry_crop|age=7', 'graveyard:skull_pile|facing=north,waterlogged=false',
];


const filter = arg('filter', null);
const keyList = arg('keys', null);
const keys = keyList ? keyList.split(';;')
  : filter ? atlas.states.filter(s => new RegExp(filter).test(s.k)).slice(0, 96).map(s => s.k)
  : DEFAULT_SET;

// quads reference textures by index into atlas.textures, not by id
const texOf = new Map(atlas.textures.map((t, i) => [i, t]));

// ---- geometry for one state (first weighted arm) --------------------------
function quadsOf(key) {
  const st = atlas.states.find(s => s.k === key);
  if (!st) return null;
  const out = [];
  if (st.cube) {
    const DIRV = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const arm = st.cube[0];
    for (let f = 0; f < 6; f++) {
      const [tid, tr] = decodeFaceCode(arm[f]);
      const tex = texOf.get(tid);
      if (!tex) continue;
      const corners = CANON_RING[f].map(p => p.split(',').map(Number));
      const uvs = corners.map((_, i) => cubeFaceUV(arm[f], i));
      out.push({ p: corners.flat(), u: uvs.flat(), t: tex, n: DIRV[f] });
    }
  } else if (st.g?.length) {
    for (const qi of st.g[0]) {
      const gi = bin.readUInt32LE(REF + qi * 8), pk = bin.readUInt32LE(REF + qi * 8 + 4);
      const tex = texOf.get(pk & 0xfff);
      if (!tex) continue;
      const p = [];
      for (let i = 0; i < 12; i++) p.push((bin.readInt16LE(POS + gi * 24 + i * 2) / posScale) * 16); // blob stores blocks; the rasteriser works in model units
      const u = [];
      for (let i = 0; i < 8; i++) u.push(bin.readUInt16LE(UV + gi * 16 + i * 2) / 65535);
      const d = ((pk >> 12) & 7) - 1;
      const DIRV = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
      let n = d >= 0 ? DIRV[d] : null;
      if (!n) {
        const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...cr) || 1;
        n = cr.map(v => v / l);
      }
      out.push({ p, u, t: tex, n });
    }
  }
  return out;
}

// ---- software rasteriser --------------------------------------------------
const lightDir = (() => { const v = [-0.4, 0.9, 0.35]; const l = Math.hypot(...v); return v.map(x => x / l); })();
function renderCell(qs, img, ox, oy, size) {
  const cx = size / 2, cy = size / 2;
  // camera looks along -d; d points from the block towards the viewer
  const d = norm([0.55, 0.62, 0.75]);
  const right = norm(cross([0, 1, 0], d));
  const up = cross(d, right);
  const ctr = [8, 8, 8];
  // fit the unit block (not modded spill) to ~72% of the cell
  const raw = (p) => [dot([p[0] - 8, p[1] - 8, p[2] - 8], right), -dot([p[0] - 8, p[1] - 8, p[2] - 8], up)];
  let ex = 0, ey = 0;
  for (const c of [[0, 0, 0], [16, 0, 0], [0, 16, 0], [16, 16, 0], [0, 0, 16], [16, 0, 16], [0, 16, 16], [16, 16, 16]]) {
    const q = raw(c); ex = Math.max(ex, Math.abs(q[0])); ey = Math.max(ey, Math.abs(q[1]));
  }
  const scale = (size * 0.72) / Math.max(ex, ey) / 2;
  const project = (p) => {
    const q = [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]];
    return [cx + dot(q, right) * scale, cy - dot(q, up) * scale, dot(q, d)];
  };
  const tris = [];
  for (const q of qs) {
    const v = [];
    for (let i = 0; i < 4; i++) v.push([project([q.p[i * 3], q.p[i * 3 + 1], q.p[i * 3 + 2]]), [q.u[i * 2], q.u[i * 2 + 1]]]);
    tris.push([v[0], v[1], v[2], q]);
    tris.push([v[0], v[2], v[3], q]);
  }
  tris.sort((a, b) => (avgz(a) - avgz(b)));
  for (const [a, b, c, q] of tris) {
    const shade = 0.55 + 0.45 * Math.abs(dot(q.n, lightDir));
    const tex = q.t;
    const x0 = Math.max(0, Math.floor(Math.min(a[0][0], b[0][0], c[0][0])));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(a[0][0], b[0][0], c[0][0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[0][1], b[0][1], c[0][1])));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(a[0][1], b[0][1], c[0][1])));
    const denom = (b[0][1] - c[0][1]) * (a[0][0] - c[0][0]) + (c[0][0] - b[0][0]) * (a[0][1] - c[0][1]);
    if (Math.abs(denom) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      let w0 = ((b[0][1] - c[0][1]) * (px - c[0][0]) + (c[0][0] - b[0][0]) * (py - c[0][1])) / denom;
      let w1 = ((c[0][1] - a[0][1]) * (px - c[0][0]) + (a[0][0] - c[0][0]) * (py - c[0][1])) / denom;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * a[0][2] + w1 * b[0][2] + w2 * c[0][2];
      const idx = (oy + y) * (COLS * size + (COLS - 1) * 4) + ox + x;
      if (zbuf[idx] !== undefined && zbuf[idx] > z) continue;
      const u = w0 * a[1][0] + w1 * b[1][0] + w2 * c[1][0];
      const v = w0 * a[1][1] + w1 * b[1][1] + w2 * c[1][1];
      const sx = tex.x + Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
      // sprite v runs from the top row of the source texture, and atlas.png rows are stored top
      // first, so v maps straight onto the cell's rows (no 1-v mirror)
      const sy = tex.y + Math.min(tex.h - 1, Math.max(0, Math.floor(v * tex.h)));
      const sp = (sy * png.w + sx) * 4;
      const alpha = png.rgba[sp + 3];
      if (alpha < 8) continue;
      zbuf[idx] = z;
      const o = idx * 4;
      const sr = png.rgba[sp] * shade, sg = png.rgba[sp + 1] * shade, sb = png.rgba[sp + 2] * shade;
      if (alpha < 250) {
        img[o] = (img[o] * (1 - alpha / 255) + sr * (alpha / 255)) | 0;
        img[o + 1] = (img[o + 1] * (1 - alpha / 255) + sg * (alpha / 255)) | 0;
        img[o + 2] = (img[o + 2] * (1 - alpha / 255) + sb * (alpha / 255)) | 0;
      } else { img[o] = sr; img[o + 1] = sg; img[o + 2] = sb; }
      img[o + 3] = 255;
    }
  }
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
const avgz = (t) => (t[0][0][2] + t[1][0][2] + t[2][0][2]) / 3;

const rows = Math.ceil(keys.length / COLS);
const W = COLS * CELL + (COLS - 1) * 4, H = rows * CELL;
const img = new Uint8Array(W * H * 4);
const zbuf = new Float64Array(W * H).fill(NaN);
for (let i = 0; i < keys.length; i++) {
  const col = i % COLS, row = (i / COLS) | 0;
  const qs = quadsOf(keys[i]);
  if (!qs || !qs.length) { console.log('NO GEOMETRY', keys[i]); continue; }
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const o = ((row * CELL + y) * W + col * (CELL + 4) + x) * 4;
    const v = ((x >> 4) + (y >> 4)) % 2 ? 46 : 36;
    img[o] = v; img[o + 1] = v; img[o + 2] = v + 6; img[o + 3] = 255;
  }
  renderCell(qs, img, col * (CELL + 4), row * CELL, CELL);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePngRgba(W, H, Buffer.from(img.buffer)));
console.log(`wrote ${OUT} (${W}x${H}, ${keys.length} states)`);
