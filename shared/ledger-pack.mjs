// M12: the served shape of the block-history log. `build/ledger/actions.bin` (shared/ledger-format.mjs)
// is the whole log - 424,599 rows, 30 MB - which is fine for a build step and wrong for a browser that
// wants "what happened around here" without downloading a database.
//
// So the bake buckets the log:
//   cells  - one entry per chunk that has any rows, with per-action counts and a player bit mask.
//            This is what the overlay paints and what a "find the bases" query sorts on.
//   chunks - the sparse cell list plus, per chunk, a slice of row indices. This is the point query:
//            "what happened to this block" costs one binary search and a handful of rows.
// Everything is sparse because the log only covers 20,322 overworld chunks out of 284,239: players
// touched a small part of this world, and an index sized to the whole extent would be 14x of air.
//
// Layout (little-endian):
//   0  magic 'LEDPK1  ' (8 B), 8 u32 version, 12 u32 dimKeyLen, 16 i32 ledgerWorldId,
//  20  u32 cellCount, 24 u32 chunkCount, 28 u32 rowCount, 32 u32 timeBaseSec, 36 u32 spanSec,
//  40  u32 tlCount
//  44  dimKey bytes
//     cells:  cellCount x 32 B   (i32 cx, i32 cz, 6 x u16 counts by action id 1..6, u32 playerMask,
//                                 u32 firstSec, u32 lastSec - seconds since timeBase)
//     heights: cellCount x u16   ground height of that chunk, biased exactly as in a shell/overview
//                                 frame (worldY + HEIGHT_BIAS); 0 = no baked height for it
//     chunks: chunkCount x 16 B  (i32 cx, i32 cz, u32 rowStart, u32 rowCount), sorted by (cz, cx)
//     rows:   rowCount x u32     indices into the exported log, in time order within a chunk
//     timeline (version 3): its own magic + dim key copy, so a slice of it is self-describing:
//       8 magic 'LEDTL1  ', u32 version, u32 count, u32 timeBaseSec, u32 spanSec, u32 dimKeyLen,
//       u32 nameCount, u32 namesBytes, dimKey bytes, nameCount x (u16 len + utf8 bytes),
//       then count x 16 B in ascending second:
//         u32 cell index (the same index cells/chunks/heights use), u32 packed local coord
//         (x 4b, z 4b, y+4096 in 13 bits), u8 action class 0..5 (6 = an action id outside the six),
//         u8 player index (255 = none), u32 second since timeBaseSec,
//         u16 name index (1-based into this section's name table; 0 = the row names no block)
//
// The timeline is version 3 and it exists for the time machine (PLAN M12b): everything else in this
// pack answers "how much happened in this chunk", which cannot replay anything. Rows are ordered by
// time, not by chunk, because the playhead moves in time. It is a separate section with its own magic
// so /ledger/cells can keep serving 674 KB while /ledger/timeline serves the 4.9 MB of rows only for a
// viewer that means to travel.
//
// What is deliberately NOT in a timeline record: the object id *string* (22,341 distinct ids, which
// would double the row), and the block properties (the log fills block_state for 2,828 of 424,599 rows,
// so there is nearly nothing to carry). What version 2 adds is the object id as a u16 into a
// per-dimension name table, because "what was this block" is the difference between decal dots and a
// terrain time machine: to put a broken block back you have to know its name. Point queries still go
// to /ledger/rows, which carries properties too.
//
// The height plane is version 2 and it is there so the overlay can be drawn without the browser
// owning a second whole-dimension height source. The world layer (/overview) is off by default here
// because the baked LOD tiles replaced it, so an overlay that asked for it would either switch a
// 16 MB layer on or have nothing to sit on. Heights are copied from the overview at bake time, where
// reading it is free, and cost 2 bytes per touched chunk.

import { HEIGHT_BIAS } from './chunk-format.mjs';

export const LEDPACK_MAGIC = 'LEDPK1  ';
export const LEDPACK_VERSION = 3;
export const LEDPACK_HEADER = 44;      // the ten u32/i32 fields; the dimKey string starts right after
export const CELL_BYTES = 32;
export const CELL_H_BYTES = 2;
export const CHUNK_BYTES = 16;
export const NCLASS = 6;             // action ids 1..6 -> array index 0..5
export const MAX_PLAYERS_IN_MASK = 32;

// --- the timeline section (version 3) -------------------------------------------------------------
export const TL_MAGIC = 'LEDTL1  ';
export const TL_VERSION = 3;
export const TL_HEADER = 36;         // magic, version, count, timeBase, span, dimKeyLen, nameCount, namesBytes
export const TL_REC = 18;            // + u16 name index, + u16 "was" index (1-based into the same table)
// A row names TWO blocks, because that is all the ledger ever says about a voxel: the block the action
// is ABOUT, and the block that stood there BEFORE it (old_object_id). For a break both are the block
// that left; for a place, "about" is what arrived and "was" is what it covered - and the log carries
// that for all 90,045 overworld place rows, which is what lets a base un-build into grass instead of
// into a hole.
//
// Version 2 (16 B rows, name but no "was") and version 1 (14 B, no names at all, so no answer to
// "what block was here") are still readable; their missing columns decode as zeros.
export const TL_VERSION_2 = 2;
export const TL_REC_2 = 16;
export const TL_VERSION_1 = 1;
export const TL_HEADER_1 = 28;
export const TL_REC_1 = 14;

/** Header size and row size of a timeline version. An unknown version is an error, not a guess. */
export function tlSizes(version) {
  if (version === TL_VERSION || version === TL_VERSION_2) {
    return { head: TL_HEADER, rec: version === TL_VERSION ? TL_REC : TL_REC_2 };
  }
  if (version === TL_VERSION_1) return { head: TL_HEADER_1, rec: TL_REC_1 };
  throw new Error(`timeline version ${version}`);
}
export const TL_NO_PLAYER = 255;
export const Y_BIAS = 4096;          // packed y covers -4096..4095; this log spans -512..299

export const tlPackCoord = (x, y, z) => {
  if (x < 0 || x > 15 || z < 0 || z > 15) throw new Error(`timeline: local coord ${x},${z} outside a chunk`);
  if (y < -Y_BIAS || y >= Y_BIAS) throw new Error(`timeline: y ${y} outside the packed range`);
  return (x & 15) | ((z & 15) << 4) | (((y + Y_BIAS) & 0x1FFF) << 8);
};
export const tlX = (c) => c & 15;
export const tlZ = (c) => (c >> 4) & 15;
export const tlY = (c) => ((c >> 8) & 0x1FFF) - Y_BIAS;

/**
 * Decode a served timeline slice into plain columns.
 *
 * Columns rather than a DataView view because a playhead walks the rows in order and a per-voxel
 * filter wants to pull a chunk's rows out by cell index; either way the row is read many times, and
 * 351,531 rows of separate typed columns decode once in a few ms.
 */
export function decodeTimeline(buf) {
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const magic = new TextDecoder('latin1').decode(new Uint8Array(view.buffer, view.byteOffset, 8));
  if (magic !== TL_MAGIC) throw new Error(`timeline: magic ${JSON.stringify(magic)}`);
  const version = dv.getUint32(8, true);
  const { head: headSize, rec: recSize } = tlSizes(version);   // throws on a version this build cannot read
  const count = dv.getUint32(12, true);
  const timeBaseSec = dv.getUint32(16, true);
  const spanSec = dv.getUint32(20, true);
  const dimKeyLen = dv.getUint32(24, true);
  const nameCount = recSize >= 16 ? dv.getUint32(28, true) : 0;
  const namesBytes = recSize >= 16 ? dv.getUint32(32, true) : 0;
  const dimKey = new TextDecoder('utf-8').decode(
    new Uint8Array(view.buffer, view.byteOffset + headSize, dimKeyLen));
  const at = headSize + dimKeyLen;
  if (view.byteLength < at + namesBytes + count * recSize) {
    throw new Error(`timeline ${dimKey}: ${at + namesBytes + count * recSize} bytes needed, got ${view.byteLength}`);
  }
  // The name table is per dimension, not global: 22,341 object ids exist across the log, but a
  // dimension touches a few thousand of them, and a u16 column is what keeps a row at 16 B.
  const names = [];
  {
    const dec = new TextDecoder('utf-8');
    let q = at;
    for (let i = 0; i < nameCount; i++) {
      const l = dv.getUint16(q, true); q += 2;
      if (q + l > view.byteLength) throw new Error(`timeline ${dimKey}: name ${i} runs past the slice`);
      names.push(dec.decode(new Uint8Array(view.buffer, view.byteOffset + q, l))); q += l;
    }
  }
  const recAt = at + namesBytes;
  const cell = new Uint32Array(count), coord = new Uint32Array(count);
  const action = new Uint8Array(count), player = new Uint8Array(count), sec = new Uint32Array(count);
  const name = new Uint16Array(count);
  const was = new Uint16Array(count);        // zeros on a pre-v3 timeline
  for (let i = 0; i < count; i++) {
    const p = recAt + i * recSize;
    cell[i] = dv.getUint32(p, true);
    coord[i] = dv.getUint32(p + 4, true);
    action[i] = dv.getUint8(p + 8);
    player[i] = dv.getUint8(p + 9);
    sec[i] = dv.getUint32(p + 10, true);
    name[i] = recSize >= 16 ? dv.getUint16(p + 14, true) : 0;
    was[i] = recSize >= 18 ? dv.getUint16(p + 16, true) : 0;
  }
  // The rows are the playhead, so "ascending second" is not a detail of the writer, it is the thing
  // the page depends on. Say so in code that runs in the browser, not only in the bake.
  for (let i = 1; i < count; i++) {
    if (sec[i] < sec[i - 1]) throw new Error(`timeline ${dimKey}: row ${i} goes back in time`);
  }
  /** Rows are sorted by second, so a time window is two binary searches. */
  const range = (fromSec, toSec) => {
    const lower = (v) => {
      let lo = 0, hi = count;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sec[m] < v) lo = m + 1; else hi = m; }
      return lo;
    };
    return [lower(fromSec), lower(toSec + 1)];
  };
  return {
    version, dimKey, count, timeBaseSec, spanSec, cell, coord, action, player, sec, name, was, names, range,
    x: (i) => tlX(coord[i]), y: (i) => tlY(coord[i]), z: (i) => tlZ(coord[i]),
    second: (i) => timeBaseSec + sec[i],
    cellOf: (i) => cell[i],
    /** the block name this row is about, or '' when the row carries none (a v1 slice always answers '') */
    nameOf: (i) => (name[i] ? names[name[i] - 1] ?? '' : ''),
    /** what stood in that voxel BEFORE this row; '' on a pre-v3 timeline */
    wasOf: (i) => (was[i] ? names[was[i] - 1] ?? '' : ''),
  };
}

export function readPack(buf) {
  // Callers arrive with either shape: Node hands over a Buffer, a browser fetch an ArrayBuffer. Handing
  // the wrong one here used to look like corrupt data on the page, because the DataView error was caught
  // and shown as "re-run the bake".
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  const magic = new TextDecoder('latin1').decode(new Uint8Array(view.buffer, view.byteOffset, 8));
  if (magic !== LEDPACK_MAGIC) throw new Error(`ledger pack: magic ${JSON.stringify(magic)}`);
  const version = dv.getUint32(8, true);
  if (version !== LEDPACK_VERSION) throw new Error(`ledger pack: version ${version} != ${LEDPACK_VERSION}`);
  const dimKeyLen = dv.getUint32(12, true);
  const worldId = dv.getInt32(16, true);
  const cellCount = dv.getUint32(20, true);
  const chunkCount = dv.getUint32(24, true);
  const rowCount = dv.getUint32(28, true);
  const timeBaseSec = dv.getUint32(32, true);
  const spanSec = dv.getUint32(36, true);
  const tlCount = version >= 3 ? dv.getUint32(40, true) : 0;
  const dimKey = new TextDecoder('utf-8').decode(
    new Uint8Array(view.buffer, view.byteOffset + LEDPACK_HEADER, dimKeyLen));
  const cellsAt = LEDPACK_HEADER + dimKeyLen;
  const heightsAt = cellsAt + cellCount * CELL_BYTES;
  const chunksAt = heightsAt + cellCount * CELL_H_BYTES;
  const rowsAt = chunksAt + chunkCount * CHUNK_BYTES;
  const need = rowsAt + rowCount * 4;
  if (view.byteLength < need) {
    throw new Error(`ledger pack ${dimKey}: ${need} bytes needed, file has ${view.byteLength}`);
  }

  // 0 in the height plane means "no baked height", not "sea level": a real column of this world
  // biases to 1984..2432, so 0 is free to mean unknown.
  const heightOf = (i) => {
    const h = dv.getUint16(heightsAt + i * CELL_H_BYTES, true);
    return h ? h - HEIGHT_BIAS : null;
  };
  const cell = (i) => {
    const p = cellsAt + i * CELL_BYTES;
    const counts = new Array(NCLASS);
    for (let c = 0; c < NCLASS; c++) counts[c] = dv.getUint16(p + 8 + c * 2, true);
    return {
      cx: dv.getInt32(p, true),
      cz: dv.getInt32(p + 4, true),
      counts,
      total: counts.reduce((a, b) => a + b, 0),
      playerMask: dv.getUint32(p + 20, true),
      firstSec: dv.getUint32(p + 24, true),
      lastSec: dv.getUint32(p + 28, true),
      y: heightOf(i),
    };
  };
  // Chunks are sorted by (cz, cx), so a chunk lookup is a binary search rather than a walk: the
  // click-a-block path runs this on every pick.
  const findChunk = (cx, cz) => {
    let lo = 0, hi = chunkCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = chunksAt + mid * CHUNK_BYTES;
      const mcx = dv.getInt32(p, true), mcz = dv.getInt32(p + 4, true);
      if (mcz < cz || (mcz === cz && mcx < cx)) lo = mid + 1;
      else if (mcz > cz || (mcz === cz && mcx > cx)) hi = mid - 1;
      else return { rowStart: dv.getUint32(p + 8, true), rowCount: dv.getUint32(p + 12, true) };
    }
    return null;
  };
  const tlAt = rowsAt + rowCount * 4;
  // A served cells slice declares chunkCount/rowCount/tlCount as zero, so a strict check here cannot
  // punish it. What it must punish is a pack that CLAIMS rows and stops short of them: the timeline is
  // the last section, and a reader that treated a truncated one as "no timeline" would turn a
  // half-written bake into a time machine with a hole in it and no complaint.
  let tlBytes = null;
  if (tlCount > 0) {
    const where = (m) => { throw new Error(`ledger pack: ${m} bytes needed, got ${view.byteLength}`); };
    if (view.byteLength < tlAt + 8) where('timeline header');
    const magic = new TextDecoder('latin1').decode(new Uint8Array(view.buffer, view.byteOffset + tlAt, 8));
    if (magic !== TL_MAGIC) throw new Error(`ledger pack: timeline magic ${JSON.stringify(magic)}`);
    const tlVer = dv.getUint32(tlAt + 8, true);
    const { head: tlHead, rec: tlRec } = tlSizes(tlVer);
    const tlDimKeyLen = dv.getUint32(tlAt + 24, true);
    const tlNameBytes = tlRec >= 16 ? dv.getUint32(tlAt + 32, true) : 0;
    const need = tlAt + tlHead + tlDimKeyLen + tlNameBytes + tlCount * tlRec;
    if (view.byteLength < need) where('timeline');
    tlBytes = [tlAt, need];
  }
  return {
    version, dimKey, worldId, cellCount, chunkCount, rowCount, timeBaseSec, spanSec,
    cell, findChunk, heightOf,
    rowIdx: (i) => dv.getUint32(rowsAt + i * 4, true),
    tlCount, tlBytes,          // tlBytes: [start, end) inside the pack file, or null
  };
}
