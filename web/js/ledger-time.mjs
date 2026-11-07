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
export function buildTimeQuads(tl, cells, order, { bias = 0.02, lift = 0.004, maxLift = 0.08 } = {}) {
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
    const [r, g, b] = colour[tl.action[i]] ?? colour[0];
    const v0 = v;
    // Winding as in buildHeatQuads: for the triangle (p0,p1,p2), (p1-p0) x (p2-p0) points at +Y. The
    // heat layer's comment writes that cross product the other way round - a comment bug there, not a
    // winding difference: these are its four corners in its order, and the test checks the sign itself.
    pos[v * 3] = wx; pos[v * 3 + 1] = yy; pos[v * 3 + 2] = wz;
    pos[(v + 1) * 3] = wx; pos[(v + 1) * 3 + 1] = yy; pos[(v + 1) * 3 + 2] = wz + 1;
    pos[(v + 2) * 3] = wx + 1; pos[(v + 2) * 3 + 1] = yy; pos[(v + 2) * 3 + 2] = wz + 1;
    pos[(v + 3) * 3] = wx + 1; pos[(v + 3) * 3 + 1] = yy; pos[(v + 3) * 3 + 2] = wz;
    for (let q = 0; q < 4; q++) {
      col[(v + q) * 3] = r; col[(v + q) * 3 + 1] = g; col[(v + q) * 3 + 2] = b;
    }
    idx[t++] = v0; idx[t++] = v0 + 1; idx[t++] = v0 + 2;
    idx[t++] = v0; idx[t++] = v0 + 2; idx[t++] = v0 + 3;
    quadSec[v / 4] = tl.sec[i];          // one entry per emitted quad, never per row considered
    v += 4;
  }
  return {
    // Trimmed to what was emitted. A skipped row still allocated four vertices and six indices, and an
    // index buffer with zero-filled slack at the end is a trap: draw the whole thing once without a draw
    // range and it renders a fan of triangles at the world origin.
    pos: pos.subarray(0, v * 3), col: col.subarray(0, v * 3), idx: idx.subarray(0, t),
    quadSec: quadSec.subarray(0, v / 4),
    quads: v / 4, verts: v, indices: t, skipped,
    lift: { bias, lift, maxLift },
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
