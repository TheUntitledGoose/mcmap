// M12 bake: turn the exported log into one sparse pack per dimension (layout in shared/ledger-pack.mjs).
//
// The whole point is that a query never touches 424,599 rows. A click costs a binary search over the
// chunk list plus a few rows; a "where is everything this player did" sweep reads only the cell table,
// which for the overworld is 20,322 entries rather than 284,239 chunks.
import fs from 'node:fs';
import path from 'node:path';
import {
  CELL_BYTES, CELL_H_BYTES, CHUNK_BYTES, LEDPACK_HEADER, LEDPACK_MAGIC, LEDPACK_VERSION, MAX_PLAYERS_IN_MASK,
  NCLASS, TL_HEADER, TL_MAGIC, TL_NO_PLAYER, TL_NO_SOURCE, TL_REC, TL_VERSION, tlPackCoord,
} from '../shared/ledger-pack.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';

/**
 * Bucket every row of one ledger world into cells + a chunk index.
 * @param L  a loaded log (shared/ledger-format.mjs)
 * @param worldId  the log's own world id
 * @param dimKey   our dimension folder key, written into the pack so a stale file is obvious
 * @param opts.heightOf  (cx, cz) -> world Y of the ground there, or null. Copied from the baked
 *                 overview so the browser can put its overlay on the ground without loading that
 *                 layer (see shared/ledger-pack.mjs for why).
 */
export function buildPack(L, worldId, dimKey, { heightOf = null } = {}) {
  const chunks = new Map();
  let tMin = Infinity, tMax = -Infinity, rows = 0;
  for (let i = 0; i < L.count; i++) {
    if (L.worldId(i) !== worldId) continue;
    const ck = `${L.z(i) >> 4}|${L.x(i) >> 4}`;
    let e = chunks.get(ck);
    if (!e) chunks.set(ck, e = {
      cx: L.x(i) >> 4, cz: L.z(i) >> 4, counts: new Uint16Array(NCLASS),
      mask: 0, first: Infinity, last: -Infinity, rows: [],
    });
    const aid = L.actionId(i);
    if (aid >= 1 && aid <= NCLASS) {
      // u16 saturates: the busiest chunk in this log holds 3,884 rows, so the cap is three orders of
      // magnitude away, but a saturation is a number the UI can still show rather than a wrap-around.
      const c = e.counts[aid - 1];
      e.counts[aid - 1] = c >= 65535 ? 65535 : c + 1;
    }
    const pid = L.playerId(i);
    if (pid) {
      if (pid > MAX_PLAYERS_IN_MASK) {
        throw new Error(`ledger pack: player id ${pid} does not fit a ${MAX_PLAYERS_IN_MASK}-bit mask`);
      }
      if (pid - 1 > TL_NO_PLAYER - 1) {
        throw new Error(`ledger pack: player id ${pid} does not fit a timeline byte (max ${TL_NO_PLAYER})`);
      }
      e.mask |= 1 << (pid - 1);
    }
    const sec = Math.floor(L.timeMs(i) / 1000);
    if (sec < e.first) e.first = sec;
    if (sec > e.last) e.last = sec;
    if (sec < tMin) tMin = sec;
    if (sec > tMax) tMax = sec;
    e.rows.push(i);
    rows++;
  }

  // Time order inside a chunk: the point query is read as a story, and a list of events that jumps
  // forward and back in time is unreadable.
  const byTime = (a, b) => L.timeMs(a) - L.timeMs(b);
  const list = [...chunks.values()];
  list.sort((a, b) => (a.cz - b.cz) || (a.cx - b.cx));
  for (const e of list) e.rows.sort(byTime);

  // Timeline: the same rows, ordered by time instead of by chunk, and carrying the block position.
  // Every chunk's row list is already in time order, so this is a k-way merge over 20k short runs -
  // a plain sort is fast enough at 351k rows and much easier to trust than a hand-rolled heap.
  const tl = new Array(rows);
  let k = 0;
  for (let ci = 0; ci < list.length; ci++) {
    for (const i of list[ci].rows) tl[k++] = [Math.floor(L.timeMs(i) / 1000), ci, i];
  }
  tl.sort((a, b) => (a[0] - b[0]) || (a[2] - b[2]));

  const dimKeyBuf = Buffer.from(dimKey, 'utf8');
  // Name table for the timeline, holding BOTH blocks a row knows about: the one the action is about and
  // the one that stood there before it (the ledger's old_object_id). For a break those are the same
  // string and intern to the same slot. Interning per dimension is what keeps each column a u16: the
  // log knows 22,341 objects, this one uses a fraction.
  const nameIdx = new Map();          // object id string -> 1-based slot
  const nameList = [];
  const intern = (key) => {
    const s = key ? L.objects.get(key)?.id ?? '' : '';
    if (!s) return 0;
    let n = nameIdx.get(s);
    if (n === undefined) {
      if (nameList.length >= 0xFFFF) throw new Error(`ledger pack ${dimKey}: name table overflow`);
      n = nameList.push(s);
      nameIdx.set(s, n);
    }
    return n;
  };
  const blockNameOf = (i) => intern(L.actionId(i) === 3 ? L.oldObjectId(i) : L.objectId(i));
  const wasNameOf = (i) => intern(L.oldObjectId(i));
  // Source table: what CAUSED the row ('player', 'creeper', 'fluid', 'gravity', ...). This is here
  // because a player's name on a row is not a body position: of this log's 123,232 player-attributed
  // rows, 28,795 are a creeper blast, a wither skull, an end crystal or TNT that the player owns, and
  // those sit a median 20 blocks (p90 166) from that player's nearest hand-attributed row. A timeline
  // without the cause cannot tell the two apart, and a ghost would jump 166 blocks at p90.
  const srcIdx = new Map();          // source string -> 0-based slot (255 is reserved for "none")
  const srcList = [];
  const internSrc = (key) => {
    const s = key ? L.sources.get(key)?.id ?? '' : '';
    if (!s) return TL_NO_SOURCE;
    let n = srcIdx.get(s);
    if (n === undefined) {
      if (srcList.length >= TL_NO_SOURCE) throw new Error(`ledger pack ${dimKey}: source table overflow`);
      n = srcList.push(s) - 1;
      srcIdx.set(s, n);
    }
    return n;
  };
  // Intern before allocating: the name table's byte size is part of the buffer size and of the header,
  // so it has to be finished before a single row is written.
  const tlName = new Uint16Array(tl.length);
  const tlWas = new Uint16Array(tl.length);
  const tlSrc = new Uint8Array(tl.length).fill(TL_NO_SOURCE);
  for (let k = 0; k < tl.length; k++) {
    tlName[k] = blockNameOf(tl[k][2]);
    tlWas[k] = wasNameOf(tl[k][2]);
    tlSrc[k] = internSrc(L.sourceId(tl[k][2]));
  }
  const nameBufs = nameList.map((s) => Buffer.from(s, 'utf8'));
  let namesBytes = 0;
  for (const b of nameBufs) namesBytes += b.length + 2;
  const srcBufs = srcList.map((s) => Buffer.from(s, 'utf8'));
  let srcBytes = 0;
  for (const b of srcBufs) srcBytes += b.length + 2;
  const head = LEDPACK_HEADER + dimKeyBuf.length;
  const tlSize = rows ? TL_HEADER + dimKeyBuf.length + namesBytes + srcBytes + rows * TL_REC : 0;
  const out = Buffer.alloc(head + list.length * (CELL_BYTES + CELL_H_BYTES)
    + list.length * CHUNK_BYTES + rows * 4 + tlSize);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out.write(LEDPACK_MAGIC, 0, 'latin1');
  dv.setUint32(8, LEDPACK_VERSION, true);
  dv.setUint32(12, dimKeyBuf.length, true);
  dv.setInt32(16, worldId, true);
  dv.setUint32(20, list.length, true);
  dv.setUint32(24, list.length, true);
  dv.setUint32(28, rows, true);
  dv.setUint32(32, tMin === Infinity ? 0 : tMin, true);
  dv.setUint32(36, tMax === -Infinity ? 0 : tMax - (tMin === Infinity ? 0 : tMin), true);
  dv.setUint32(40, rows, true);      // tlCount: the timeline section trails the row index
  dimKeyBuf.copy(out, LEDPACK_HEADER);

  let p = head;
  for (const e of list) {
    dv.setInt32(p, e.cx, true);
    dv.setInt32(p + 4, e.cz, true);
    for (let c = 0; c < NCLASS; c++) dv.setUint16(p + 8 + c * 2, e.counts[c], true);
    dv.setUint32(p + 20, e.mask, true);
    dv.setUint32(p + 24, e.first - tMin, true);
    dv.setUint32(p + 28, e.last - tMin, true);
    p += CELL_BYTES;
  }
  // Heights go in their own plane rather than growing the 32 B cell record: the cell record is the
  // part every query walks, and 0 has to mean "no baked height" because a real column of this world
  // biases to a few hundred above zero.
  for (const e of list) {
    const y = heightOf ? heightOf(e.cx, e.cz) : null;
    if (y === null || y === undefined) dv.setUint16(p, 0, true);
    else {
      const hb = y + HEIGHT_BIAS;
      if (!(hb >= 1 && hb <= 65535)) throw new Error(`ledger pack ${dimKey}: height ${y} out of range`);
      dv.setUint16(p, hb, true);
    }
    p += CELL_H_BYTES;
  }
  let start = 0;
  for (const e of list) {
    dv.setInt32(p, e.cx, true);
    dv.setInt32(p + 4, e.cz, true);
    dv.setUint32(p + 8, start, true);
    dv.setUint32(p + 12, e.rows.length, true);
    p += CHUNK_BYTES;
    start += e.rows.length;
  }
  for (const e of list) {
    for (const i of e.rows) { dv.setUint32(p, i, true); p += 4; }
  }

  // The timeline section carries its own magic and dim key so a slice of it is self-describing:
  // /ledger/timeline ships these bytes and nothing else.
  if (rows) {
    out.write(TL_MAGIC, p, 'latin1');
    dv.setUint32(p + 8, TL_VERSION, true);
    dv.setUint32(p + 12, rows, true);
    dv.setUint32(p + 16, tMin === Infinity ? 0 : tMin, true);
    dv.setUint32(p + 20, tMax === -Infinity ? 0 : tMax - (tMin === Infinity ? 0 : tMin), true);
    dv.setUint32(p + 24, dimKeyBuf.length, true);
    dv.setUint32(p + 28, nameList.length, true);
    dv.setUint32(p + 32, namesBytes, true);
    dv.setUint32(p + 36, srcList.length, true);
    dv.setUint32(p + 40, srcBytes, true);
    dimKeyBuf.copy(out, p + TL_HEADER);
    p += TL_HEADER + dimKeyBuf.length;
    for (const b of nameBufs) { dv.setUint16(p, b.length, true); p += 2; b.copy(out, p); p += b.length; }
    for (const b of srcBufs) { dv.setUint16(p, b.length, true); p += 2; b.copy(out, p); p += b.length; }
    for (let k = 0; k < tl.length; k++) {
      const [sec, ci, i] = tl[k];
      dv.setUint32(p, ci, true);
      dv.setUint32(p + 4, tlPackCoord(L.x(i) & 15, L.y(i), L.z(i) & 15), true);
      const aid = L.actionId(i);
      dv.setUint8(p + 8, aid >= 1 && aid <= NCLASS ? aid - 1 : NCLASS, true);
      const pid = L.playerId(i);
      dv.setUint8(p + 9, pid ? pid - 1 : TL_NO_PLAYER, true);
      dv.setUint32(p + 10, sec - (tMin === Infinity ? 0 : tMin), true);
      dv.setUint16(p + 14, tlName[k], true);
      dv.setUint16(p + 16, tlWas[k], true);
      dv.setUint8(p + 18, tlSrc[k], true);
      p += TL_REC;
    }
  }
  return { buf: out, cellCount: list.length, rowCount: rows, tMin, tMax, tlBytes: tlSize,
    nameCount: nameList.length, srcCount: srcList.length };
}

export const packPath = (dir, dimKey) => path.join(dir, `${dimKey}.ledpack`);

export function writePack(dir, dimKey, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const to = packPath(dir, dimKey);
  const tmp = `${to}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, to);     // same discipline as the payload cache: a reader never sees half a file
  return to;
}
