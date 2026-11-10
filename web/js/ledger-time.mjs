// M12b: the time machine's data half - "show this world being built".
//
// DOM-free and three-free like the rest of web/js. Everything that decides *what the log is claiming
// happened, and when* lives here where a test can ask it directly; the page owns the mesh and the
// scrubber.
//
// What makes this cheap is an ordering the bake already guarantees: the timeline rows (shared/
// ledger-pack.mjs -> /ledger/timeline) are sorted by time. So one mesh, built with one quad per row in
// that order, turns the playhead into `geometry.setDrawRange(0, n * 6)`. Moving through two years of
// history costs a binary search and one number, not a rebuild - which is the difference between a
// scrubber and a slideshow. Rebuilding only happens when the FILTER changes.
//
// Two things this deliberately does not do:
//   - deduplicate voxels. A block placed, broken, and placed again is three rows, and drawing all three
//     is the story ("Rome was rebuilt"). Repeated quads in the same voxel would z-fight, so each repeat
//     is lifted by a sub-millimetre `lift` instead - later ones sit fractionally higher.
//   - terrain-as-of-T. Blocks that exist today but were broken before T are not removed here; that is
//     tier 2 in PLAN M12b, and it needs reverse-replay against the voxel payloads.

import { ACTION_NAME } from '../../shared/ledger-format.mjs';
import { NCLASS, TL_NO_PLAYER } from '../../shared/ledger-pack.mjs';
import { srgbToLinear } from './shell-mesh.js';

/**
 * Per-action colours in sRGB, converted by `actionLinear` into the space three composites in.
 * Not the heat ramp: heat answers "how much", this answers "what kind", so the two layers must not look
 * like the same thing. `place` is the one the time machine usually shows, so it gets the colour that
 * reads as "this appeared".
 */
export const ACTION_COLOUR = {
  1: [0.62, 0.62, 0.70],   // change
  2: [0.16, 0.78, 0.34],   // place
  3: [0.92, 0.26, 0.20],   // break
  4: [0.24, 0.66, 0.86],   // insert
  5: [0.90, 0.55, 0.16],   // remove
  6: [0.72, 0.32, 0.78],   // kill
};

export const actionLinear = (cls) => {
  const c = ACTION_COLOUR[cls] ?? ACTION_COLOUR[1];
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])];
};

/**
 * The rows a playhead should show, in time order (the timeline already is, and this preserves it).
 *
 * `who` 0 means anybody, and includes the overworld's 269,358 rows that name no player at all - 77 % of
 * them. Most of what this ledger recorded was not credited to a person, so a viewer that defaults to
 * "one player" is showing a quarter of the history and should say so.
 *
 * `cls` 0 means every action kind. 1..6 is one of the six classes the log records by name. 7 means "any
 * other action": the timeline stores the six as indices 0..5 and reserves 6 for an action id outside them,
 * so that bucket needs its own filter value rather than falling through to "everything".
 *
 * `limit` keeps the first `limit` rows in time order - so the NEWEST rows are the ones dropped - and
 * `truncated` says that happened.
 *
 * Returns columns rather than row objects: the caller walks these once to build geometry, and 351,531
 * row objects would be the expensive part of a filter change.
 */
export function filterRows(tl, { who = 0, cls = 0, limit = 0 } = {}) {
  const wantPlayer = who > 0 ? who - 1 : -1;
  const wantAction = cls >= 1 && cls <= NCLASS ? cls - 1 : (cls === NCLASS + 1 ? NCLASS : -1);
  const order = new Int32Array(tl.count);
  const sec = new Uint32Array(tl.count);
  let n = 0, other = 0, truncated = false;
  for (let i = 0; i < tl.count; i++) {
    if (wantAction >= 0 && tl.action[i] !== wantAction) { other++; continue; }
    if (wantPlayer >= 0 && tl.player[i] !== wantPlayer) { other++; continue; }
    order[n] = i; sec[n] = tl.sec[i]; n++;
    if (limit && n >= limit) { truncated = i + 1 < tl.count; break; }
  }
  return { order: order.subarray(0, n), sec: sec.subarray(0, n), n, other, truncated };
}

/**
 * One flat quad per row, in the same order as `order`, four corners + six indices like every other mesh
 * in this viewer.
 *
 * `cells` is the chunk table the heat layer already holds - either a readPack view (it has `.cell(i)`) or
 * an array of `{cx, cz}`. A timeline row carries a chunk INDEX rather than chunk coordinates, so without
 * this table a row cannot be placed in the world at all; rows whose index is not in the table are counted
 * in `skipped` rather than guessed at.
 *
 * A quad sits on its block's own top face, so a place marks the block that appeared and a break marks the
 * hole it left at the same height. `quadSec` is the playhead index: `quadAt(quadSec, t)` is how many
 * quads the draw range should cover at time t.
 */
export function buildTimeQuads(tl, cells, order, { bias = 0.02, lift = 0.004, maxLift = 0.08, shrink = 1 } = {}) {
  const cellAt = typeof cells?.cell === 'function' ? (i) => cells.cell(i) : (i) => cells?.[i];
  const n = order.length;
  const pos = new Float32Array(n * 4 * 3);
  const col = new Float32Array(n * 4 * 3);
  const idx = n * 4 < 65536 ? new Uint16Array(n * 6) : new Uint32Array(n * 6);
  // Sized for the rows, then returned trimmed to the quads actually emitted. It must stay compact:
  // `quadAt()` answers in QUADS and the caller multiplies by six for the draw range, so a hole left by a
  // skipped row would make the draw range cover more indices than exist - geometry drawn out of order, or
  // past the end of the buffer.
  const quadSec = new Uint32Array(n);
  // Which timeline row each quad came from. It is NOT the same numbering as `order` whenever a row was
  // skipped, and "click this block, show me when it happened" has to answer with a quad, so the mapping
  // leaves this function instead of being guessed by the caller.
  const quadRow = new Int32Array(n);
  // Repeats of one voxel are lifted rather than dropped, and the count per voxel is all that has to be
  // remembered. A packed number key keeps this a Map of numbers: |x| and |z| stay inside 2^21 in this
  // save and y inside 13 bits, so the key fits a double exactly (max ~2^47).
  const seen = new Map();
  const colour = [];
  for (let c = 0; c <= NCLASS; c++) colour[c] = actionLinear(c + 1);
  let v = 0, t = 0, skipped = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const c = cellAt(tl.cellOf(i));
    if (!c || c.cx === undefined || c.cz === undefined) { skipped++; continue; }
    const wx = c.cx * 16 + tl.x(i), wz = c.cz * 16 + tl.z(i), y = tl.y(i);
    const key = (wx + 2097152) * 17179869184 + (y + 4096) * 4194304 + (wz + 2097152);
    const rep = seen.get(key) ?? 0;
    seen.set(key, rep + 1);
    const yy = y + 1 + bias + Math.min(maxLift, rep * lift);
    // `shrink` insets the tile inside its own block, about the block's centre. A full-block tile is a
    // sticker that hides the block it is about: at any zoom past close-in, the map becomes an opaque
    // quilt of flat squares and the terrain under it cannot be read. Inset leaves each block's own edge
    // and the seams between blocks open, which is the same legibility trick as the heat layer's `inset`.
    const half = 0.5 * Math.max(0.02, Math.min(1, shrink));
    const px0 = wx + 0.5 - half, px1 = wx + 0.5 + half;
    const pz0 = wz + 0.5 - half, pz1 = wz + 0.5 + half;
    const [r, g, b] = colour[tl.action[i]] ?? colour[0];
    const v0 = v;
    // Winding as in buildHeatQuads: for the triangle (p0,p1,p2), (p1-p0) x (p2-p0) points at +Y. The
    // heat layer's comment writes that cross product the other way round - a comment bug there, not a
    // winding difference: these are its four corners in its order, and the test checks the sign itself.
    pos[v * 3] = px0; pos[v * 3 + 1] = yy; pos[v * 3 + 2] = pz0;
    pos[(v + 1) * 3] = px0; pos[(v + 1) * 3 + 1] = yy; pos[(v + 1) * 3 + 2] = pz1;
    pos[(v + 2) * 3] = px1; pos[(v + 2) * 3 + 1] = yy; pos[(v + 2) * 3 + 2] = pz1;
    pos[(v + 3) * 3] = px1; pos[(v + 3) * 3 + 1] = yy; pos[(v + 3) * 3 + 2] = pz0;
    for (let q = 0; q < 4; q++) {
      col[(v + q) * 3] = r; col[(v + q) * 3 + 1] = g; col[(v + q) * 3 + 2] = b;
    }
    idx[t++] = v0; idx[t++] = v0 + 1; idx[t++] = v0 + 2;
    idx[t++] = v0; idx[t++] = v0 + 2; idx[t++] = v0 + 3;
    quadSec[v / 4] = tl.sec[i];          // one entry per emitted quad, never per row considered
    quadRow[v / 4] = i;
    v += 4;
  }
  return {
    // Trimmed to what was emitted. A skipped row still allocated four vertices and six indices, and an
    // index buffer with zero-filled slack at the end is a trap: draw the whole thing once without a draw
    // range and it renders a fan of triangles at the world origin.
    pos: pos.subarray(0, v * 3), col: col.subarray(0, v * 3), idx: idx.subarray(0, t),
    quadSec: quadSec.subarray(0, v / 4), quadRow: quadRow.subarray(0, v / 4),
    quads: v / 4, verts: v, indices: t, skipped,
    lift: { bias, lift, maxLift }, shrink,
  };
}

/**
 * How many quads exist at or before a time. `quadSec` is ascending, so this is a binary search: the
 * answer is what `setDrawRange` gets every frame, and a frame that scrubbed two years must not have
 * walked 351,531 rows to find it.
 */
export function quadAt(quadSec, sec) {
  let lo = 0, hi = quadSec.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (quadSec[m] <= sec) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * Where the playhead is, for the panel readout and for a probe to assert. `sec` counts from
 * `tl.timeBaseSec`, which is what the timeline stores; `ms` is wall-clock for the date a person reads.
 */
export function playhead(tl, sec) {
  const span = tl.spanSec;
  const at = Math.max(0, Math.min(span, sec));
  return {
    sec: at,
    frac: span > 0 ? at / span : 0,
    firstMs: tl.timeBaseSec * 1000,
    lastMs: (tl.timeBaseSec + span) * 1000,
    ms: (tl.timeBaseSec + at) * 1000,
  };
}

/** The action names the legend and the card use, so the time layer cannot invent its own vocabulary. */
export const actionName = (cls) => ACTION_NAME[cls] ?? `#${cls}`;

/**
 * One number for one block: the timeline's chunk index plus its packed local coordinate. A cell index is
 * under 2^31 and a packed coord under 2^21, so the product fits a double exactly - the same trick
 * `buildTimeQuads` uses for its repeat counter, and the reason this is a Map of numbers rather than a Map
 * of strings.
 */
export const voxelKey = (cell, coord) => cell * 2097152 + coord;

/**
 * Group the drawn quads by the block they are about, so a card can ask "when did THIS block change?".
 *
 * `tl` is the decoded timeline and `quadRow` the mapping `buildTimeQuads` returns, so the answer is a quad
 * index - the thing a draw range can be set from - and not a row index that only means something before
 * filtering. Each group stays in time order because `quadSec` does.
 *
 * Built on demand and cached by the page: 351,531 rows is a few ms and an array per touched block, which
 * is not a price worth paying on every filter change when almost nobody clicks a block.
 */
export function voxelRows(tl, quadRow) {
  const m = new Map();
  for (let q = 0; q < quadRow.length; q++) {
    const i = quadRow[q];
    const key = voxelKey(tl.cellOf(i), tl.coord[i]);
    const a = m.get(key);
    if (a) a.push(q); else m.set(key, [q]);
  }
  return m;
}

/**
 * The change to one exact block closest to a moment - by default the last one at or before it, which is
 * the state a playhead sitting at that moment shows. When nothing in the group is that old, the answer is
 * the earliest change instead, with `before: 0`, so the caller can say "this block's history starts later"
 * instead of pretending the rewind worked.
 *
 * `n` is how many changes that block has under the current filter and `later` how many come after the one
 * picked, which is what makes "3 more after this one, keep scrubbing" possible on the card.
 */
export function rowForBlock(groups, quadSec, cell, coord, sec = null) {
  const list = groups.get(voxelKey(cell, coord));
  if (!list || !list.length) return null;
  let at = list.length - 1;
  let before = 1;
  if (sec !== null) {
    let lo = 0, hi = list.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (quadSec[list[mid]] <= sec) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) { at = 0; before = 0; } else at = best;
  }
  const q = list[at];
  return { quad: q, sec: quadSec[q], n: list.length, before, later: list.length - 1 - at };
}

/**
 * Whether each kind of logged action leaves a BLOCK standing in the voxel it touched, indexed by the
 * timeline's 0-based action byte (0 change, 1 place, 2 break, 3 container insert, 4 container remove,
 * 5 kill, 6 an action id outside those six).
 *
 * `null` is not "the code does not know": it is "this action makes no claim about a block". An entity
 * dying in a doorway, or an item put into a chest, says nothing about whether the wall beside it stands,
 * so the viewer has to fall back to what the chunks say rather than invent an answer. `change` counts as
 * standing because it is a state swap of a block that is there - a lever flipped, a slab re-oriented.
 */
export const CLAIMS_STAND = [1, 1, 0, null, null, null, null];

/** The action byte as a person would read it. Byte 6 is deliberately vague, because it is vague. */
export const claimName = (byte) => (byte >= 0 && byte < CLAIMS_STAND.length - 1
  ? actionName(byte + 1)
  : 'some other logged action');

/**
 * What stood in a voxel when the log's EARLIEST word about it comes after the moment being asked about.
 * The row cannot be read directly then - it has not happened yet - so it is read backwards, and only two
 * of the six claims support a backwards reading: a block that the log later changed or broke was standing
 * beforehand, and a placement says nothing about what it landed on unless the ledger also named the block
 * that was there before (its `was`), in which case the honest answer is "unknown".
 */
export const beforeClaim = (tl, row) => {
  const cls = tl.action[row] ?? CLAIMS_STAND.length - 1;
  if (cls === 0 || cls === 2) return 1;                 // changed or broken later: it was standing
  if (cls === 1) return tl.was?.[row] ? null : 0;       // placed later: empty under it, unless named otherwise
  return null;                                          // containers, kills, anything else
};

/**
 * A chunk's state key and the log's block name for the same block, made comparable.
 *
 * The payload names a state `minecraft:oak_stairs|facing=north` (the census key), and the ledger names an
 * object `minecraft:oak_stairs`: same block, different spelling. Properties are not part of the question
 * "does this block stand here", so they come off before comparing.
 */
export const plainName = (k) => (k ? String(k).split('|')[0] : null);

/**
 * The first row strictly after `sec` that PLACES this named block in this voxel.
 *
 * Only a placement proves an arrival: a `change` row is a state swap of a block that was already standing,
 * and a break names the block that left. So this asks one question - does the log say the very block you
 * are pointing at appears later than the moment? - and answers it by walking that voxel's rows, which is
 * short (measured: 292 rows on the busiest voxel in this save, 2 rows median).
 */
export function arrivalOfBlock(tl, groups, quadRow, quadSec, cell, coord, sec, name) {
  const nm = plainName(name);
  if (!nm) return null;
  const list = groups.get(voxelKey(cell, coord));
  if (!list || !list.length) return null;
  let lo = 0, hi = list.length - 1, first = list.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (quadSec[list[mid]] > sec) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  for (let k = first; k < list.length; k++) {
    const row = quadRow[list[k]];
    if ((tl.action[row] ?? CLAIMS_STAND.length - 1) === 1 && tl.nameOf?.(row) === nm) {
      return { row, cls: 1, sec: quadSec[list[k]] };
    }
  }
  return null;
}

/**
 * Does a block stand in this voxel at this moment, as far as the log knows?
 *
 * The pick question this exists for: the mesh under a cursor is today's world (and, within the replay
 * square, the playhead's), so the outline used to land on a block that only appears three weeks after the
 * playhead. The row that decides the answer is the last one at or before the moment - and when the block's
 * history starts LATER than the moment, the same table still answers, read the other way: the first claim
 * being a place means the block was not there yet, and the first claim being a break means it was there
 * until then.
 *
 * `stands` is 1, 0, or null for "the log has nothing to say about this voxel" - which is also the answer
 * when the time machine is off or the filter names nobody who touched it. `row`/`cls`/`sec` say which row
 * decided it and `n`/`later` how much more history that voxel has, so a caller can print a reason instead
 * of silently refusing the pixel. `cls` is the timeline's 0-based action byte; `claimName(cls)` is the word
 * to show a person. When the answer is "not there", `starts` names the first claim after the moment.
 */
export function standsAt(tl, groups, quadRow, quadSec, cell, coord, sec, name = null) {
  const other = CLAIMS_STAND.length - 1;
  const r = rowForBlock(groups, quadSec, cell, coord, sec);
  if (!r) return null;
  const row = quadRow[r.quad];
  const cls = tl.action[row] ?? other;
  const out = { stands: 1, row, cls, sec: r.sec, before: r.before, n: r.n, later: r.later };
  // Two readings, and which one applies is the whole subtlety: a row at or behind the moment is read
  // forwards (what that kind of action leaves behind), a moment older than the voxel's whole history is
  // read backwards off the oldest row.
  out.stands = r.before ? (CLAIMS_STAND[cls] ?? null) : beforeClaim(tl, row);
  // "Not there" is only useful if it says when the voxel becomes something: the first claim AFTER this
  // moment is the moment it stops being empty, and the hover/card can name the date.
  if (!r.before || !out.stands) {
    const nxt = nextRowForBlock(groups, quadSec, cell, coord, sec + 1);
    if (nxt) {
      const nrow = quadRow[nxt.quad];
      const ncls = tl.action[nrow] ?? other;
      out.starts = { row: nrow, cls: ncls, sec: nxt.sec };
    }
  }
  // The third reading, and the one that answers what a cursor is actually pointing at. The rules above
  // speak about the VOXEL; a pick wants to know about the BLOCK it hit, which the mesh drew from today's
  // chunks. If the log names that block's own placement after this moment, then it does not stand at this
  // moment - which is the case the outline kept getting wrong, because a shell layer cannot be re-cut by
  // the replay and keeps painting a wall the playhead has not built yet.
  //
  // A name that merely DIFFERS is not evidence of absence (an unlogged plugin edit would look identical),
  // so this only ever adds a refusal when the log says the block itself arrives.
  if (name) {
    const nm = plainName(name);
    const decided = out.stands === 1 && tl.nameOf?.(out.row) === nm;
    if (!decided) {
      const arr = arrivalOfBlock(tl, groups, quadRow, quadSec, cell, coord, sec, nm);
      if (arr) {
        out.stands = 0;
        out.arrival = arr;
        out.starts = out.starts ?? { row: arr.row, cls: arr.cls, sec: arr.sec };
      }
    }
  }
  return out;
}

/**
 * The first row at or after `sec` for this voxel. Rows in `groups` are in filter time order and `quadSec`
 * is non-decreasing along them, so this is the mirror-image binary search of `rowForBlock`: where
 * `rowForBlock` answers "what had happened by then", this answers "what happens next".
 */
export function nextRowForBlock(groups, quadSec, cell, coord, sec) {
  const list = groups.get(voxelKey(cell, coord));
  if (!list || !list.length) return null;
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (quadSec[list[mid]] >= sec) { best = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (best < 0) return null;
  const q = list[best];
  return { quad: q, sec: quadSec[q], n: list.length, after: list.length - 1 - best };
}
