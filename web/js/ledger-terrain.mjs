// M12b Tier 2: the world as it was at the playhead, in voxels rather than in decals.
//
// Tier 1 draws a dot where something happened. This answers a harder question: stand at time T and
// what would the terrain look like? The page already holds the present voxels, and the ledger timeline
// now names the block each row is about, so the present is corrected backwards.
//
// The question is per VOXEL, not per row: "what stood in this voxel at T?" Not "undo every newer row one
// at a time" - that made a block vanish at the moment it was placed, because the undo of a second
// placement blanks the voxel that the first placement filled. For each voxel the timeline touches:
//
//   a row at/behind T            -> its effect: a break leaves air, a place/change leaves its `name`
//   no row at/behind T           -> the `was` of its oldest row: what it covered before it arrived
//   no newer row at all          -> no edit: today's voxel is already the answer
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
export const isBreak = (actionByte) => actionByte === 2;    // aid 3  block-break
export const isPlace = (actionByte) => actionByte === 1;    // aid 2  block-place
export const isChange = (actionByte) => actionByte === 0;   // aid 1  block-change

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
 * The edits to hand a chunk: `[packedCoord, stateId]` pairs, one per voxel the log touched, state 0 meaning
 * "take it away".
 *
 * The question is not "which rows are newer than the playhead" - it is "what stood in that voxel AT the
 * playhead", and that is whatever the LAST row not newer than it left behind:
 *
 * A row carries both halves of what it did, and the playhead asks for one of them:
 *
 *   at or BEHIND a row   -> the AFTER block: a place's block, a change's new block, air for a break
 *   read BACK past a row -> the BEFORE block: a break's removed block, a change's old block, and for a
 *                           place whatever it covered
 *
 * Reading backwards is what un-builds a world, and reading forwards is what builds it back. In this save
 * the two columns turn out to be worth very different amounts, which is worth writing down because it
 * decides what a future timeline version should carry:
 *
 *   block-break   (202,826 rows) before == the block that left, which is what `name` already holds
 *   block-place    (90,045 rows) before is minecraft:air for EVERY one of them - the log never records
 *                                what a placement covered, so an un-build cannot reveal ground it never
 *                                saw. A torch placed on generated dirt un-builds to air.
 *   block-change   (36,787 rows) before differs from after in 36,676 of them (99.7%), and the top pair
 *                                is grass_block -> dirt (35,581 rows: tilling, paths, trampling). So
 *                                modelling this class is the whole gain of the second column: scrub back
 *                                over a path and the grass it was cut from comes back.
 *
 * Only voxels with at least one row NEWER than the playhead get an edit: if nothing in the log after that
 * moment touched the voxel, what the payload says is already what stood there. One edit per voxel - a chunk
 * whose 4,254 rows fall on 8,501 voxels costs 8,501 edits, not 4,254 writes in sequence.
 *
 * Only voxels with at least one row NEWER than the playhead get an edit: if nothing in the log after that
 * moment touched the voxel, what the payload says is already what stood there. One edit per voxel - a chunk
 * whose 4,254 rows fall on 8,501 voxels costs 8,501 edits, not 4,254 writes in sequence.
 *
 * @param tl        decoded timeline
 * @param rows      that cell's row indices, ascending in time (see rowsByCell)
 * @param sec       playhead, in the timeline's own base-relative seconds
 * @param stateIdFor  name -> global state id (1-based, 0 when the name is not a block in the atlas)
 * @param limit     cap on edits from this chunk, so a 4,000-row chunk cannot stall a frame
 * @returns edits plus what they cost: `truncated` is the number of voxels the cap left showing today
 */
export function editsForCell(tl, rows, sec, stateIdFor, limit = 0) {
  const start = firstAfter(tl, rows, sec);
  const none = {
    edits: new Int32Array(0), breakRows: 0, placeRows: 0, changeRows: 0, otherRows: 0, unknown: 0,
    truncated: 0,
  };
  if (start === rows.length) return none;
  // The rows ascend, so one pass over the cell's rows gives three facts per voxel: the newest row at or
  // behind the playhead, the oldest row that ever touched it, and whether anything happens after the
  // playhead at all (only those voxels need an edit - the payload is already right for the rest).
  const behind = new Map();   // packed coord -> newest row at/behind the playhead
  const first = new Map();    // packed coord -> oldest row that touched it, ever
  const newer = new Set();    // packed coords with a row after the playhead
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k], c = tl.coord[r];
    if (!first.has(c)) first.set(c, r);
    if (k < start) behind.set(c, r); else newer.add(c);
  }
  let breakRows = 0, placeRows = 0, changeRows = 0, otherRows = 0, unknown = 0, truncated = 0;
  const edits = new Int32Array(newer.size * 2);
  let w = 0;
  for (const c of newer) {
    const back = behind.get(c);
    const use = back === undefined ? first.get(c) : back;
    const atOrBehind = back !== undefined;
    const act = tl.action[use];
    if (isBreak(act)) breakRows++;
    else if (isPlace(act)) placeRows++;
    else if (isChange(act)) changeRows++;
    else { otherRows++; continue; }        // an item, a kill: no claim on a voxel
    // AFTER is what the row left standing (air for a break, since a break's record names what left);
    // BEFORE is what it replaced, which for a break is again the block it removed, and for a place or a
    // change is the row's second name column. A pre-v3 slice has no second column, so reading backwards
    // over a place or a change knows nothing and leaves the payload alone.
    const name = atOrBehind
      ? (isBreak(act) ? '' : tl.nameOf(use))
      : (isBreak(act) ? tl.nameOf(use) : (tl.wasOf ? tl.wasOf(use) : ''));
    const id = stateIdFor(name);
    if (id) { edits[w++] = c; edits[w++] = id; }
    else if (atOrBehind && isBreak(act)) { edits[w++] = c; edits[w++] = 0; }        // a break leaves air
    else if (!atOrBehind && isPlace(act)) { edits[w++] = c; edits[w++] = 0; }       // it had not arrived
    else unknown++;      // the log names a block the atlas does not model, or knows nothing
    if (limit && w / 2 >= limit) { truncated = 1; break; }
  }
  // "Bounded" is a number a note can print, not a flag: say how many of the voxels it needed to touch were
  // left showing today.
  if (truncated) truncated = newer.size - w / 2;
  return { edits: edits.subarray(0, w), breakRows, placeRows, changeRows, otherRows, unknown, truncated };
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

/**
 * Visit a square of chunks from the middle outwards, until `visit` says stop.
 *
 * The playhead's mark budget is small (192 chunks) and the square it is spent on is as wide as the detail
 * ring - 71x71 at a zoomed-out framing - so the walk ORDER is the policy, not an optimisation. Walking the
 * square row by row from its far corner spent the whole budget on chunks 35 chunks away and left the house
 * under the user's eye showing today. Ring order means the budget always buys what the camera is looking
 * at first, and a chunk that is not re-cut is a chunk the replay never claims to have undone.
 *
 * `visit(cx, cz)` returning false stops the walk, and the return value says whether the square finished.
 */
export function scanFromCentre(cx0, cz0, r, visit) {
  for (let d = 0; d <= r; d++) {
    for (let dz = -d; dz <= d; dz++) {
      for (let dx = -d; dx <= d; dx++) {
        // Only the border of this Chebyshev ring: the inside was visited by an earlier d.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        if (visit(cx0 + dx, cz0 + dz) === false) return false;
      }
    }
  }
  return true;
}
