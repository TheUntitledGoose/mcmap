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
//  20  u32 cellCount, 24 u32 chunkCount, 28 u32 rowCount, 32 u32 timeBaseSec, 36 u32 spanSec
//  40  dimKey bytes
//     cells:  cellCount x 32 B   (i32 cx, i32 cz, 6 x u16 counts by action id 1..6, u32 playerMask,
//                                 u32 firstSec, u32 lastSec - seconds since timeBase)
//     heights: cellCount x u16   ground height of that chunk, biased exactly as in a shell/overview
//                                 frame (worldY + HEIGHT_BIAS); 0 = no baked height for it
//     chunks: chunkCount x 16 B  (i32 cx, i32 cz, u32 rowStart, u32 rowCount), sorted by (cz, cx)
//     rows:   rowCount x u32     indices into the exported log, in time order within a chunk
//
// The height plane is version 2 and it is there so the overlay can be drawn without the browser
// owning a second whole-dimension height source. The world layer (/overview) is off by default here
// because the baked LOD tiles replaced it, so an overlay that asked for it would either switch a
// 16 MB layer on or have nothing to sit on. Heights are copied from the overview at bake time, where
// reading it is free, and cost 2 bytes per touched chunk.

import { HEIGHT_BIAS } from './chunk-format.mjs';

export const LEDPACK_MAGIC = 'LEDPK1  ';
export const LEDPACK_VERSION = 2;
export const LEDPACK_HEADER = 40;
export const CELL_BYTES = 32;
export const CELL_H_BYTES = 2;
export const CHUNK_BYTES = 16;
export const NCLASS = 6;             // action ids 1..6 -> array index 0..5
export const MAX_PLAYERS_IN_MASK = 32;

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
  return {
    version, dimKey, worldId, cellCount, chunkCount, rowCount, timeBaseSec, spanSec,
    cell, findChunk, heightOf,
    rowIdx: (i) => dv.getUint32(rowsAt + i * 4, true),
  };
}
