/**
 * The skin pack on disk, and the one texture the browser is going to want.
 *
 * `tools/fetch-skins.mjs` writes `build/skins/manifest.json` plus one PNG per player. The page does NOT
 * want one texture per player: the people layer is one mesh with a handful of draw groups, and six
 * materials is six programs for six 64x64 images. So the server packs the whole cast side by side into
 * one strip and the browser uploads that once.
 *
 * The strip's LAST cell is solid white, and it is not a person. A player with no skin entry gets their
 * UVs pointed there, and the body's own vertex colour paints them - which is why "no skin for this one"
 * is a material answer and not a second, drift-prone geometry path. Anything reading the strip must know
 * how many cells it has, so the layout travels with it (`/skins/strip.json`), not in a comment.
 *
 * 64x32 skins are legal and older: they go in the cell top-aligned, and the model's own UV table already
 * knows to reuse the right-arm/right-leg rectangles for the left limbs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePngRgba } from './png.mjs';

export const SKIN_CELL = 64;

/** The manifest, or null with the reason. A missing pack is normal: it is derived and optional. */
export function readSkinPack(dir) {
  if (!dir || dir === 'none') return { pack: null, why: 'skins disabled' };
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { pack: null, why: `no ${file}` };
  let man;
  try { man = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { pack: null, why: `${file}: ${e.message}` }; }
  const list = [];
  const missing = [];
  for (const s of man.skins || []) {
    if (!s.texture) { if (s.name) missing.push({ name: s.name, why: s.noProfile ? 'no Mojang profile' : 'no texture recorded' }); continue; }
    const p = path.join(dir, s.texture);
    if (!fs.existsSync(p)) { missing.push({ name: s.name || s.uuid, why: `${s.texture} is not on disk` }); continue; }
    let png;
    try { png = decodePng(fs.readFileSync(p)); }
    catch (e) { missing.push({ name: s.name || s.uuid, why: `undecodable PNG: ${e.message}` }); continue; }
    if (png.w !== 64 || (png.h !== 32 && png.h !== 64)) {
      missing.push({ name: s.name || s.uuid, why: `${png.w}x${png.h}: a skin is 64x64 or 64x32` });
      continue;
    }
    list.push({
      name: s.name || null, uuid: s.uuid || null, slim: !!s.slim, hash: s.hash || null,
      file: s.texture, w: png.w, h: png.h, rgba: png.rgba,
    });
  }
  return { pack: { generated: man.generated || null, world: man.world || null, source: man.source || null, list, missing }, why: null };
}

/**
 * Compose the strip: every skin in its own 64-px cell, left to right, then one white cell.
 * Returns `{w, h, rgba, columns, cells}` - `cells[i]` says which player owns column i, and the last one
 * is `{white: true}`.
 */
export function buildStrip(pack, { cell = SKIN_CELL } = {}) {
  const cells = pack.list.map((s, i) => ({ column: i, name: s.name, slim: s.slim, hash: s.hash, w: s.w, h: s.h }));
  const white = { column: cells.length, white: true };
  cells.push(white);
  const columns = cells.length;
  const w = columns * cell, h = cell;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * w + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  };
  // The white cell is filled FIRST, and everything else is painted over it: a hole anywhere in the strip
  // then reads as white-with-the-player's-own-colour, which is the fallback, rather than as a black box.
  for (let x = white.column * cell; x < w; x++) {
    for (let y = 0; y < h; y++) put(x, y, 255, 255, 255, 255);
  }
  pack.list.forEach((s, col) => {
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < 64; x++) {
        const src = (y * 64 + x) * 4;
        put(col * cell + x, y, s.rgba[src], s.rgba[src + 1], s.rgba[src + 2], s.rgba[src + 3]);
      }
    }
  });
  return { w, h, rgba, columns, cells, white: white.column };
}

export function stripPng(strip) {
  return encodePngRgba(strip.w, strip.h, strip.rgba);
}

/** The JSON half of the contract: what column means what, and how wide the strip is. */
export function stripJson(strip, pack) {
  return {
    generated: pack.generated, world: pack.world, source: pack.source,
    cell: SKIN_CELL, columns: strip.columns, white: strip.white,
    cells: strip.cells,
    missing: pack.missing.map((m) => ({ name: m.name, why: m.why })),
  };
}

/** Read + compose in one go, with the manifest mtime so a caller can tell when to redo it. */
export function skinStripFor(dir) {
  const { pack, why } = readSkinPack(dir);
  if (!pack) return { pack: null, why };
  const strip = buildStrip(pack);
  let mtime = 0;
  try { mtime = fs.statSync(path.join(dir, 'manifest.json')).mtimeMs; } catch { /* no manifest, no pack */ }
  return { pack, strip, why: null, mtime };
}
