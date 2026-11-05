// On-disk container for baked coarse LOD tiles: a 40 byte header (shared/lod-format.mjs) followed by
// the deflated vertex body. worldd inflates before serving, so the browser never needs a decompressor.
//
//   build/lods/<dimkey>/<rx>_<rz>.bin
//
// Same region granularity and same stamp discipline as the shell packs: a tile is only valid for the
// atlas whose state ids its colours were computed from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  LOD_MAGIC, LOD_VERSION, LOD_HEADER, LOD_CELL, LOD_BYTES_PER_VERT,
  encodeLodTile, openLodTile,
} from '../shared/lod-format.mjs';

export { LOD_MAGIC, LOD_VERSION, LOD_HEADER, LOD_CELL };

export const lodPath = (dir, rx, rz) => path.join(dir, `${rx}_${rz}.bin`);

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

/** Every tile file in a dimension's directory, as {rx,rz}. */
export function listLodTiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.bin')) continue;
    const m = /^(-?\d+)_(-?\d+)\.bin$/.exec(n);
    if (m) out.push({ rx: +m[1], rz: +m[2] });
  }
  return out.sort((a, b) => a.rx - b.rx || a.rz - b.rz);
}
