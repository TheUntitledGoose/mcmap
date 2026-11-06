// Bake the coarse LOD layer: every region of every dimension, meshed once into a vertex stream and
// stored, so the far view is a file read forever instead of meshing on every pan and zoom.
//
//   node server/bake-lod.mjs [--packs build/shells] [--out build/lods] [--assets build/assets]
//                            [--dim <id-or-key>] [--force] [--cells 16,4]
//
// It reads the shell packs, never the save: no NBT, no chunk decode. That is why this bake takes
// minutes rather than the 45 minutes a save pass takes, and why it can be re-run after every far-paint
// policy change if anyone ever wants to.
//
// The mesher used is the browser's own (web/js/shell-mesh.js) on the browser's own shell frames
// (web/js/payload.js), so a baked tile is byte-for-byte what the live far layer would have made at
// that cell size. There is no second implementation of far paint to keep honest.
//
// The cost of a rung is columns, and columns go as 1/cell^2: the overworld is 2.4 M verts at cell 16,
// 32 M at cell 4, and 762 M at cell 1 (~1.7 GB of vertices and 60 M triangles), which is why the
// ladder stops at 4 and the last rung stays live-meshed.
import fs from 'node:fs';
import path from 'node:path';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { shellFrameCols } from './shell.mjs';
import { ShellPack, atlasStamp } from './shell-pack.mjs';
import { lodPath, lodFileBytes, listPackRegions, listLodTiles, loadLodTile } from './lod-pack.mjs';
import { LOD_CELL, LOD_CELLS, lodCellDir } from '../shared/lod-format.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PACKS = arg('packs', 'build/shells');
const OUT = arg('out', 'build/lods');
const ASSETS = arg('assets', 'build/assets');
// The ladder. Anything not in LOD_CELLS is a typo, not a rung: the reader would refuse those tiles.
const CELLS = String(arg('cells', arg('cell', LOD_CELLS.join(',')))).split(/[ ,]+/)
  .filter(Boolean).map((c) => +c).filter((c) => c >= 1);
const BAD = CELLS.filter((c) => !LOD_CELLS.includes(c));
if (BAD.length) { console.error(`cell ${BAD.join(',')} is not a rung of the ladder (${LOD_CELLS.join(',')})`); process.exit(1); }
if (!CELLS.length) { console.error('no cells to bake'); process.exit(1); }
const ONLY = arg('dim', null);
const FORCE = argv.includes('--force');
// The far-paint policy baked in. These are the shipped defaults from web/js/main.js; the header
// carries them and the viewer refuses a tile it would not have painted the same way.
const SKIRT = +arg('skirt', 24);
const POLICY = {
  groundFar: +arg('groundfar', 1),
  waterOpacity: +arg('water', 0.72),
  aoFar: +arg('aofar', 0.949),           // tools/dbg-aohist.mjs, sampled 48 chunks
  lightOn: arg('light', '1') !== '0',
  darkFloor: +arg('darkfloor', 0.32),
  darkGamma: +arg('darkgamma', 0.72),
  skyScale: +arg('skyscale', 1),
  caps: arg('caps', '1') !== '0',
  capDrop: +arg('capdrop', 4),
};

const atlasStat = fs.statSync(path.join(ASSETS, 'atlas.json'));
const atlas = JSON.parse(fs.readFileSync(path.join(ASSETS, 'atlas.json'), 'utf8'));
const STAMP = atlasStamp(atlasStat, atlas.states.length);
const geo = fs.readFileSync(path.join(ASSETS, 'geometry.bin'));
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

const dirs = fs.readdirSync(PACKS).filter((n) => {
  const full = path.join(PACKS, n);
  return fs.statSync(full).isDirectory() && (!ONLY || n === ONLY || n.includes(ONLY));
});
if (!dirs.length) { console.error(`no pack directories under ${PACKS}`); process.exit(1); }

const perCell = new Map(CELLS.map((c) => [c, { tiles: 0, verts: 0, bytes: 0 }]));
let skipped = 0, t0 = Date.now();
for (const key of dirs) {
  const src = path.join(PACKS, key);
  const dst = path.join(OUT, key);
  const found = listPackRegions(src);
  if (!found.length) { console.log(`${key}: no packs, skipping`); continue; }
  // Region cache: a tile needs its eight neighbours for the skirt walls at its border, and neighbouring
  // tiles need the same packs back again. A pack is 1 MB inflated / ~1 ms, so keep a dozen warm.
  const packs = new Map();
  const frameAt = new Map();
  const packAt = (rx, rz) => {
    const k = `${rx},${rz}`;
    if (packs.has(k)) return packs.get(k);
    const p = ShellPack.load(path.join(src, `${rx}_${rz}.bin`), STAMP);
    packs.set(k, p);
    if (packs.size > 12) {
      const [oldK, oldP] = packs.entries().next().value;
      packs.delete(oldK);
      if (oldP) p && oldP.free();
    }
    return p;
  };
  const shellAt = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (frameAt.has(k)) return frameAt.get(k);
    const p = packAt(cx >> 5, cz >> 5);
    const cols = p && p.cols(cx, cz);
    let f = null;
    if (cols) {
      const buf = shellFrameCols(cx, cz, cols.h, cols.cover, cols.g, cols.s, cols.light, cols.band);
      f = openShellFrame(buf.buffer, 0, buf.length);
    }
    frameAt.set(k, f);
    return f;
  };

  const made = new Map(CELLS.map((c) => [c, 0])), done = new Map(CELLS.map((c) => [c, 0]));
  const vt = new Map(CELLS.map((c) => [c, 0])), bt = new Map(CELLS.map((c) => [c, 0]));
  for (const { rx, rz } of found) {
    // Finest rung last: a region's frames are already warm from the coarse pass, and the fine pass is
    // the slow one, so the cache is doing its work where it matters.
    for (const cell of CELLS) {
      const dest = lodPath(dst, cell, rx, rz);
      if (!FORCE && fs.existsSync(dest)) {
        try {
          const t = loadLodTile(dest, STAMP);
          if (t) { done.set(cell, done.get(cell) + 1); continue; }
        } catch { /* stale or unreadable: rewrite it */ }
      }
      const cx0 = rx * 32, cz0 = rz * 32;
      const { stream } = meshShellPatch(assets, shellAt, cx0, cz0, 32, 32, {
        cell, maxSkirt: SKIRT, blend: 1, cap: 1 << 20, ...POLICY,
      });
      if (!stream.count) { skipped++; continue; }
      const file = lodFileBytes({
        rx, rz, stamp: STAMP, cell, pos: stream.position, col: stream.color,
        count: stream.count, policy: POLICY,
      });
      fs.mkdirSync(path.join(dst, lodCellDir(cell)), { recursive: true });
      const tmp = `${dest}.tmp`;
      fs.writeFileSync(tmp, file);
      fs.renameSync(tmp, dest);
      made.set(cell, made.get(cell) + 1);
      vt.set(cell, vt.get(cell) + stream.count);
      bt.set(cell, bt.get(cell) + file.length);
      perCell.get(cell).tiles++; perCell.get(cell).verts += stream.count; perCell.get(cell).bytes += file.length;
    }
    frameAt.clear();                      // frames alias the pack buffers; drop them before moving on
  }
  for (const p of packs.values()) if (p) p.free();
  console.log(`${key}: ${CELLS.map((c) => `cell ${c}: ${made.get(c)} baked/${done.get(c)} current, `
    + `${(vt.get(c) / 1000).toFixed(0)}k verts, ${(bt.get(c) / 1e6).toFixed(1)} MB, `
    + `${((vt.get(c) / Math.max(1, made.get(c))) | 0)} v/tile`).join(' | ')}`);
}
for (const c of CELLS.sort((a, b) => b - a)) {
  const s = perCell.get(c);
  console.log(`cell ${c}: ${s.tiles} tiles, ${(s.verts / 1e6).toFixed(2)} M verts, ${(s.bytes / 1e6).toFixed(1)} MB`);
}
console.log(`cells ${CELLS.join(',')}, skirt ${SKIRT}, policy ${JSON.stringify(POLICY)}`);
console.log(`stamp ${STAMP}: ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT} `
  + `(${listLodTiles(path.join(OUT, dirs[0])).length} tiles in ${dirs[0]} alone)`);
