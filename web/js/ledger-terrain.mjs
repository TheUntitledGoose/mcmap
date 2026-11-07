// M12b Tier 2: the world as it was at the playhead, in voxels rather than in decals.
//
// Tier 1 draws a dot where something happened. This answers a harder question: stand at time T and
// what would the terrain look like? The page already holds the present voxels, and the ledger timeline
// now names the block each row is about, so the present is corrected backwards - undo every logged
// action newer than the playhead:
//
//   a block broken after T      -> put it back, using the name the log recorded
//   a block placed after T      -> take it away
//   anything else (signs, containers, kills, dispensers) -> left alone and counted
//
// Rows for one voxel are undone newest first, so the value that survives is the effect of the *oldest*
// row after the playhead, which is what the world looked like immediately after that event - and no
// event between it and T touched that voxel.
//
// What this deliberately does not pretend:
//   The log fills `block_state` for 2,828 of 424,599 rows, so a restored block is known by *name*, not
//   by properties. The renderer's own state table decides the form: the variant with the fewest
//   properties, which is a block's default. A fence without its axis, a stair facing south.
//   Rows whose name is not a block in the atlas (an entity kill, an item drop, a mod object the save
//   never had a model for) are counted as `unknown` and change nothing.
//   Light is not re-simulated: a restored block keeps the light value the present cell carries.
//
// DOM-free, three-free, worker-safe: it edits the plain decoded-payload shape, which is what both the
// render thread and the mesh workers hold.

import { tlX, tlY, tlZ } from '../../shared/ledger-pack.mjs';

// Action classes as the timeline stores them (`aid - 1`, 6 = an id outside the six).
export const TL_ACT_OTHER = 6;
export const isBreak = (actionByte) => actionByte === 2;    // aid 3
export const isPlace = (actionByte) => actionByte === 1;    // aid 2

/**
 * Group a filtered row set by chunk cell, keeping time order.
 *
 * `order` comes from `filterRows` and is already ascending in time, and a subsequence of a sorted
 * sequence is sorted, so each cell's row list is a valid timeline for that chunk. One pass, and the
 * result is what a per-chunk undo reads.
 */
export function rowsByCell(tl, order) {
  const counts = new Map();
  for (let i = 0; i < order.length; i++) {
    const c = tl.cell[order[i]];
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const out = new Map();
  for (const [c, n] of counts) out.set(c, new Int32Array(n));
  const at = new Map();
  for (const c of out.keys()) at.set(c, 0);
  for (let i = 0; i < order.length; i++) {
    const r = order[i], c = tl.cell[r];
    const w = at.get(c);
    out.get(c)[w] = r;
    at.set(c, w + 1);
  }
  return out;
}

/** First index in an ascending row list whose second is greater than `sec`. */
export function firstAfter(tl, rows, sec) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tl.sec[rows[m]] <= sec) lo = m + 1; else hi = m; }
  return lo;
}

/** How many of a cell's rows are newer than the playhead. Cheap, and enough to stamp a mesh key. */
export const rowsAfterCount = (tl, rows, sec) => rows.length - firstAfter(tl, rows, sec);

/**
 * Build the voxel edits for one chunk: `[packedCoord, stateId]` pairs, stateId 0 meaning air.
 *
 * @param tl        decoded timeline
 * @param rows      that cell's row indices, ascending in time (see rowsByCell)
 * @param sec       playhead, in the timeline's own base-relative seconds; rows strictly after it are undone
 * @param stateIdFor  name -> global state id (1-based, 0 when the name is not a block in the atlas)
 * @param limit     stop after this many rows of the chunk, so a 4,000-row chunk cannot stall a frame
 */
export function editsForCell(tl, rows, sec, stateIdFor, limit = 0) {
  const start = firstAfter(tl, rows, sec);
  const values = new Map();                 // packed coord -> state id to write
  let breakRows = 0, placeRows = 0, otherRows = 0, unknown = 0, truncated = 0;
  // Newest first: the oldest surviving write is the last one applied, which is the state at the
  // playhead. Ascending order with "first write wins" would be equivalent but reads wrong.
  let n = rows.length - start;
  if (limit && n > limit) { truncated = n - limit; n = limit; }
  for (let k = rows.length - 1, done = 0; done < n; k--, done++) {
    const r = rows[k];
    const a = tl.action[r];
    const c = tl.coord[r];
    if (isBreak(a)) {
      breakRows++;
      const nm = tl.nameOf(r);
      const id = nm ? stateIdFor(nm) : 0;
      if (!nm || !id) { unknown++; continue; }
      values.set(c, id);
    } else if (isPlace(a)) {
      placeRows++;
      values.set(c, 0);
    } else otherRows++;
  }
  const edits = new Int32Array(values.size * 2);
  let w = 0;
  for (const [c, v] of values) { edits[w++] = c; edits[w++] = v; }
  return { edits, breakRows, placeRows, otherRows, unknown, truncated };
}

/**
 * Apply edits to a decoded chunk, returning a patched copy.
 *
 * The store's payload is shared - the render thread, the workers and the pick/ray probes all read it -
 * so nothing here writes into it. The palette and every touched section are copied; untouched sections
 * are shared read-only.
 *
 * @param ch     a decoded payload chunk (web/js/payload.js openChunk shape)
 * @param edits  [packedCoord, stateId] pairs from editsForCell
 * @param opts.withAccessors  rebuilds sectionAt/stateAt/lightAt over a section list (payload.js exports it)
 * @param opts.airId          global state id of air, for sections the payload never had
 */
export function applyEdits(ch, edits, { withAccessors = null, airId = 0 } = {}) {
  // Array.from, not slice(): a decoded payload's palette is a TYPED array, and a typed array has no
  // push. The first browser run of this layer found that by dying in the mesh worker. The palette is a
  // few hundred numbers at most, so the copy is not the cost; growing an immutable-length buffer is.
  const palette = Array.from(ch.palette);
  const slotOf = new Map();
  for (let i = 0; i < palette.length; i++) if (!slotOf.has(palette[i])) slotOf.set(palette[i], i);
  const slotFor = (stateId) => {
    let s = slotOf.get(stateId);
    if (s === undefined) {
      if (palette.length >= 0xFFFF) throw new Error(`patched palette overflows ${0xFFFF} slots`);
      s = palette.length;
      palette.push(stateId);
      slotOf.set(stateId, s);
    }
    return s;
  };
  const sections = [];
  const byY = new Map();
  const cloned = new Set();
  for (const s of ch.sections) {
    const c = { y: s.y, single: s.single, vox: s.vox, sky: s.sky, blk: s.blk, skyArr: s.skyArr, blkArr: s.blkArr };
    sections.push(c);
    byY.set(c.y, c);
  }
  // A uniform section holds one palette slot for all 4,096 voxels, so editing one voxel means expanding
  // it. A section the payload left out entirely (all air, never written) means inventing one, and its
  // untouched voxels have to read as air rather than as palette slot 0, which is a real slot.
  const targetFor = (y) => {
    let s = byY.get(y >> 4);
    if (!s) {
      // The payload omits a section that is entirely air, so inventing one means its 4,095 untouched
      // voxels must still read as air. Palette slot 0 is a legitimate slot, not "nothing": fill with
      // the slot that really holds the air state id.
      s = { y: y >> 4, single: 0, vox: new Uint16Array(4096) };
      s.vox.fill(slotFor(airId));
      sections.push(s);
      byY.set(s.y, s);
      cloned.add(s);
      return s;
    }
    if (!cloned.has(s)) {
      if (s.single) {
        s.vox = new Uint16Array(4096).fill(s.single - 1);
        s.single = 0;
      } else {
        s.vox = s.vox.slice();      // never write through into the shared payload bytes
      }
      cloned.add(s);
    }
    return s;
  };
  let applied = 0, cleared = 0;
  for (let i = 0; i < edits.length; i += 2) {
    const c = edits[i], want = edits[i + 1];
    // An edit value of 0 means "take the block away". The payload's own air is a real global state id
    // (1-based), and 0 in a payload means *unknown state*, which the mesher draws as a placeholder.
    // Confusing the two would paint the hole with the missing-chunk texture.
    const stateId = want === 0 ? airId : want;
    const y = tlY(c);
    const s = targetFor(y);
    const slot = slotFor(stateId);
    s.vox[((y & 15) << 8) | ((tlZ(c) & 15) << 4) | (tlX(c) & 15)] = slot;
    applied++;
    if (!want) cleared++;
  }
  const out = {
    ...ch, palette, sections,
    digest: ch.digest ^ (applied * 0x9e3779b1),     // different voxels, different fingerprint
    patched: applied, patchedCleared: cleared,
  };
  delete out.sectionAt; delete out.stateAt; delete out.surfaceAt; delete out.lightAt;
  if (withAccessors) withAccessors(out);
  return out;
}

/**
 * name -> global state id, from the renderer's own state table.
 *
 * The log names a block ("minecraft:stone"); the atlas table keys carry properties
 * ("minecraft:deepslate|axis=y"). Since the log's `block_state` is empty for all but 2,828 rows, the
 * only honest choice is the block's plainest form: the entry with the fewest properties, ties going to
 * the lowest index so the answer is deterministic.
 */
export function stateIdsByName(states) {
  const best = new Map();
  for (let i = 0; i < states.length; i++) {
    const k = states[i].k ?? states[i].key ?? '';
    const at = k.indexOf('|');
    const name = at < 0 ? k : k.slice(0, at);
    const props = at < 0 ? 0 : k.split('|').length - 1;
    const cur = best.get(name);
    if (!cur || props < cur.props) best.set(name, { id: i + 1, props });
  }
  const id = new Map();
  for (const [name, v] of best) id.set(name, v.id);
  return id;
}

/**
 * The mesh-key stamp of a chunk: how many of its logged rows are newer than the playhead, or '' when
 * none are. Rows are time-ordered, so "newer than T" is a SUFFIX of the chunk's row list, and a suffix
 * of the same length is the same suffix - which makes a count exact rather than approximate. Two
 * playheads with the same count undo the same rows, produce the same voxels, and must produce the same
 * key, because the mesh parked under the old key is still correct.
 *
 * That is what makes a scrub affordable: moving the playhead re-keys only the chunks that have a row
 * between the old and the new playhead. Most of the map keeps its key, and with it its parked triangles.
 */
export const histStamp = (tl, rows, sec) => {
  if (!rows || !rows.length) return '';
  const n = rowsAfterCount(tl, rows, sec);
  return n ? `x${n}` : '';
};
