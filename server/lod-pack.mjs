// On-disk container for baked coarse LOD tiles: a 40 byte header (shared/lod-format.mjs) followed by
// the deflated vertex body. worldd inflates before serving, so the browser never needs a decompressor.
//
//   build/lods/<dimkey>/c<cell>/<rx>_<rz>.bin
//
// One directory per rung of the ladder, because the rungs are baked and retired independently: cell 4
// costs 16x the bake time and 13x the bytes of cell 16, so a build that only has the coarse rung on
// disk is a normal state, not a half-finished one.
//
// Same region granularity and same stamp discipline as the shell packs: a tile is only valid for the
// atlas whose state ids its colours were computed from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  LOD_MAGIC, LOD_VERSION, LOD_HEADER, LOD_CELL, LOD_CELLS, LOD_BYTES_PER_VERT, lodCellDir,
  encodeLodTile, openLodTile,
} from '../shared/lod-format.mjs';

export { LOD_MAGIC, LOD_VERSION, LOD_HEADER, LOD_CELL, LOD_CELLS };

export const lodPath = (dir, cell, rx, rz) => path.join(dir, lodCellDir(cell), `${rx}_${rz}.bin`);

/** @param {{rx,rz,stamp,pos,col,count,policy}} t @returns {Buffer} file contents */
export function lodFileBytes(t) {
  const img = encodeLodTile(t);
  const head = img.subarray(0, LOD_HEADER);
  const comp = zlib.deflateSync(img.subarray(LOD_HEADER), { level: 6 });
  const out = Buffer.alloc(LOD_HEADER + comp.length);
  out.set(head, 0);
  out.writeUInt32LE(comp.length, 24);        // stored as compressed length in the file
  out.set(comp, LOD_HEADER);
  return out;
}

/**
 * Read a tile file back into a tile image. `wantStamp` rejects tiles baked against another atlas
 * instead of drawing a world whose block colours came from a different table.
 *
 * @returns {{rx,rz,stamp,cell,verts,policy,pos:Float32Array,col:Uint8Array}|null} null when absent
 */
export function loadLodTile(file, wantStamp = null) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  const magic = raw.subarray(0, 8).toString('ascii');
  if (magic !== LOD_MAGIC) throw new Error(`${file}: bad lod magic ${JSON.stringify(magic)}`);
  if (raw.readUInt16LE(8) !== LOD_VERSION) throw new Error(`${file}: lod version ${raw.readUInt16LE(8)}`);
  const verts = raw.readUInt32LE(20);
  const compLen = raw.readUInt32LE(24);
  if (raw.length < LOD_HEADER + compLen) throw new Error(`${file}: truncated (${raw.length})`);
  const body = zlib.inflateSync(raw.subarray(LOD_HEADER, LOD_HEADER + compLen));
  if (body.length !== verts * LOD_BYTES_PER_VERT) {
    throw new Error(`${file}: body ${body.length} != ${verts} verts`);
  }
  // The header the browser reads: the file's own header, with the body length corrected from the
  // deflated length the file stores to the image length the reader validates against.
  const head = raw.subarray(0, LOD_HEADER);
  const ab = new ArrayBuffer(LOD_HEADER + body.length);
  new Uint8Array(ab).set(raw.subarray(0, LOD_HEADER));
  new Uint8Array(ab).set(body, LOD_HEADER);
  new DataView(ab).setUint32(24, body.length, true);   // the image's own uncompressed length
  const t = openLodTile(ab, 0, ab.byteLength, wantStamp);
  t.head = head;
  return t;
}

/** Which region slots have shell packs (the bake's work list). */
export function listPackRegions(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^(-?\d+)_(-?\d+)\.bin$/.exec(n);
    if (m) out.push({ rx: +m[1], rz: +m[2] });
  }
  return out.sort((a, b) => a.rx - b.rx || a.rz - b.rz);
}

/**
 * Vertex count from a tile's 24-byte header prefix, without inflating its body. The tile's own header
 * keeps `verts` at offset 20 (offset 24 is repurposed as the deflated length), so the answer is exact
 * and costs one small read.
 *
 * It is worth that read because the browser budgets the far layer per tile. When the only cost it had
 * was "average verts of the tiles of that rung I happen to be holding", the number a decision was
 * measured against was produced by that decision: fine tiles arrive, the average rises, the budget
 * line slides inward, the tiles that just arrived are released, the average falls, they are asked for
 * again. That is the flash the user saw - "they try to load the higher lods but the moment they finish,
 * the lower lods immediately take over back".
 */
export function lodVertsOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(24);
    const n = fs.readSync(fd, b, 0, 24, 0);
    return n >= 24 ? b.readUInt32LE(20) : 0;
  } catch { return 0; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* gone */ } }
}

/** Every tile file in a dimension's LOD directory, as {cell,rx,rz,verts}, coarsest rung first. */
export function listLodTiles(dir) {
  const out = [];
  for (const sub of listDirs(dir)) {
    if (!sub.startsWith('c') || !/^c\d+$/.test(sub)) continue;
    const cell = +sub.slice(1);
    let names;
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const n of names) {
      const m = /^(-?\d+)_(-?\d+)\.bin$/.exec(n);
      if (m) {
        const file = path.join(dir, sub, n);
        out.push({ cell, rx: +m[1], rz: +m[2], verts: lodVertsOf(file) });
      }
    }
  }
  return out.sort((a, b) => b.cell - a.cell || a.rx - b.rx || a.rz - b.rz);
}

const listDirs = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/**
 * What /meta says about the baked far layer: how many dimensions have tiles, how many tiles in total,
 * and which rungs of the ladder exist. This lives next to the reader on purpose. When the counting
 * code was written separately, against the folder layout rather than the reader, a layout change made
 * it report "nothing baked" - and the browser then declined the baked layer without an error line
 * anywhere, leaving the far world to live meshing with no hint of why.
 */
export function summarizeLodDir(dir) {
  let dims = 0, tiles = 0;
  const cells = new Set();
  for (const sub of listDirs(dir)) {
    const d = path.join(dir, sub);
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    const t = listLodTiles(d);
    if (t.length) { dims++; tiles += t.length; for (const x of t) cells.add(x.cell); }
  }
  return { dims, tiles, cells: [...cells].sort((a, b) => b - a) };
}
