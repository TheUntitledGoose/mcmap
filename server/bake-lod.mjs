// Bake the coarse LOD layer: every region of every dimension, meshed once into a vertex stream and
// stored, so the far view is a file read forever instead of meshing on every pan and zoom.
//
//   node server/bake-lod.mjs [--packs build/shells] [--out build/lods] [--assets build/assets]
//                            [--dim <id-or-key>] [--force] [--cell 16]
//
// It reads the shell packs, never the save: no NBT, no chunk decode. That is why this bake takes
// minutes rather than the 45 minutes a save pass takes, and why it can be re-run after every far-paint
// policy change if anyone ever wants to.
//
// The mesher used is the browser's own (web/js/shell-mesh.js) on the browser's own shell frames
// (web/js/payload.js), so a baked tile is byte-for-byte what the live far layer would have made at
// that cell size. There is no second implementation of far paint to keep honest.
import fs from 'node:fs';
import path from 'node:path';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { shellFrameCols } from './shell.mjs';
import { ShellPack, atlasStamp } from './shell-pack.mjs';
import { lodPath, lodFileBytes, listLodTiles, loadLodTile } from './lod-pack.mjs';
import { LOD_CELL } from '../shared/lod-format.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PACKS = arg('packs', 'build/shells');
const OUT = arg('out', 'build/lods');
const ASSETS = arg('assets', 'build/assets');
const CELL = Math.max(1, Math.min(16, +arg('cell', LOD_CELL) | 0));
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

let tiles = 0, verts = 0, bytes = 0, skipped = 0, t0 = Date.now();
for (const key of dirs) {
  const src = path.join(PACKS, key);
  const dst = path.join(OUT, key);
  const found = listLodTiles(src);
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
      if (oldP) oldP.free();
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
      const buf = shellFrameCols(cx, cz, cols.h, cols.cover, cols.g, cols.s, cols.light);
      f = openShellFrame(buf.buffer, 0, buf.length);
    }
    frameAt.set(k, f);
    return f;
  };

  let made = 0, done = 0, vt = 0;
  for (const { rx, rz } of found) {
    const dest = lodPath(dst, rx, rz);
    if (!FORCE && fs.existsSync(dest)) {
      try {
        const t = loadLodTile(dest, STAMP);
        if (t) { done++; continue; }
      } catch { /* stale or unreadable: rewrite it */ }
    }
    const cx0 = rx * 32, cz0 = rz * 32;
    const { stream } = meshShellPatch(assets, shellAt, cx0, cz0, 32, 32, {
      cell: CELL, maxSkirt: SKIRT, blend: 1, cap: 1 << 20, ...POLICY,
    });
    frameAt.clear();                      // frames alias the pack buffers; drop them before moving on
    if (!stream.count) { skipped++; continue; }
    const file = lodFileBytes({
      rx, rz, stamp: STAMP, cell: CELL, pos: stream.position, col: stream.color,
      count: stream.count, policy: POLICY,
    });
    fs.mkdirSync(dst, { recursive: true });
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, file);
    fs.renameSync(tmp, dest);
    tiles++; made++; vt += stream.count; bytes += file.length; verts += stream.count;
  }
  for (const p of packs.values()) if (p) p.free();
  console.log(`${key}: ${made} tiles baked, ${done} current, ${skipped} empty, `
    + `${(vt / 1000).toFixed(0)}k verts, ${(bytes / 1e6).toFixed(1)} MB, `
    + `${((vt / Math.max(1, made)) | 0)} verts/tile`);
}
console.log(`cell ${CELL} blocks/column, skirt ${SKIRT}, policy ${JSON.stringify(POLICY)}`);
console.log(`stamp ${STAMP}: ${tiles} tiles, ${(verts / 1e6).toFixed(2)} M verts, `
  + `${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}`);
