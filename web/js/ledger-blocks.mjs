// M12b tier 3: draw a logged change as the BLOCK it was, tinted by what happened to it.
//
// The tier-1 time layer paints a flat coloured tile on top of the voxel a change touched. From 300 m up
// that reads fine and costs one quad per row. Close in it is unreadable: a green square on a roof does not
// say "deepslate brick", and a red square in a hole does not say which block left. This module emits the
// state's own baked model geometry instead - six sprite faces for a cube, the authored quads for a slab,
// stair, wall, pane or plant - with the action's colour multiplied over the sprite. Same atlas, same baked
// models, same face shading as the world's own mesher: the marker IS the block, wearing green or red.
//
// DOM-free and three-free like the rest of web/js: it hands back typed arrays plus a per-marker index, and
// the page owns the mesh and the draw range.
//
// The draw-range trick still works, and it is the reason this is affordable. Markers are emitted in the
// filter's time order, so `markerEnd[m]` (how many INDICES exist up to and including marker m) is ascending
// and a playhead is one binary search plus one number, exactly as `quadSec` works for the tile layer.
//
// Why the cube is a hair bigger than the block (the `grow` option): a drawn placement marker whose chunk
// the terrain replay has already corrected stands in the SAME voxel as the block it describes, so all six
// of its faces are coplanar with that block's faces. Coplanar plus one polygon-offset is a tinted square
// painted on the roof, which is what a person reads as "a flat 2D tile, and no block". Scaling the marker
// about the block centre by a fraction of a block puts every face outside the real one, and the same claim
// reads as a block.
//
// Two honest limits:
//   A row whose block name the atlas does not know (entity kills, item actions, mod objects that were never
//   baked) has no shape to draw. They are counted in `stats.unknown` and, when the atlas has a placeholder
//   sprite, drawn as that placeholder rather than silently dropped.
//   Six faces per marker is six times the tiles. `maxQuads` degrades a whole build from cubes to plates
//   (top face only, still the block's own texture) and then stops, and the caller prints the number.

import { emitCubeFace, emitQuad, hash3, VertexStream } from './mesher.js';
import { decodeFaceCode } from '../../shared/cube-path.mjs';

/**
 * Per-action colour wash, indexed by the TIMELINE action byte (0 change, 1 place, 2 break, 3 insert,
 * 4 remove, 5 kill, 6 an action outside those six). Not `ACTION_COLOUR`: that one is a fill colour for a
 * flat tile, and using it as a multiplier turns a grey stone sprite into near-black green. These are
 * multipliers kept close to white so the sprite still reads as itself, with the kind of change unmistakable.
 */
export const ACTION_WASH = [
  [0.50, 0.68, 1.00],   // 0 change: it was one block and became another
  [0.42, 1.00, 0.52],   // 1 place: it appeared
  [1.00, 0.38, 0.30],   // 2 break: it left
  [0.45, 0.85, 1.00],   // 3 container insert
  [1.00, 0.68, 0.30],   // 4 container remove
  [0.78, 0.40, 1.00],   // 5 entity kill
  [0.80, 0.80, 0.80],   // 6 an action this viewer has no name for
];

/** A cube face order: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east (shared/faces.mjs -> DIRS). */
const ALL_FACES = [0, 1, 2, 3, 4, 5];
const TOP_ONLY = [1];

/** Neighbour lookups for a lone marker: -1 means "unknown", which culls nothing. */
const NO_AT = () => -1;
const FAKE_CHUNK = { cx: 0, cz: 0 };

/**
 * Emit one marker per row of `order` (the filter's row list, ascending in time).
 *
 * `assets` is the packed atlas the mesher uses, `byName` a Map from block name to the 1-BASED global state
 * id (`stateIdsByName(assets.states)`), because a timeline row names a block, never one of its states.
 *
 * `plates` emits a cube's top face instead of its six sides: still the block's own sprite and still tinted,
 * one sixth the geometry. `maxQuads` stops the build at a quad count, in which case `stats.stopped` says so
 * and the markers that exist are the OLDEST ones - the scrubber reads forward, so cutting the tail would
 * hide the changes a person is watching for.
 *
 * Returns `done()` streams (indexed) plus three parallel per-marker arrays:
 *   markerSec  the row's second, ascending - binary search it with `quadAt`
 *   markerEnd  cumulative INDEX count through this marker - the draw range is `markerEnd[n-1]`
 *   markerRow  the timeline row, so a click on a face answers with the right row
 *   markerCx/markerCz the CHUNK each marker stands in, so the page can say how many of the changes it
 *              draws fall inside the square where the blocks themselves replay (a note, not a guess)
 */
export function buildTimeBlocks(tl, cells, order, assets, byName, opts = {}) {
  // `grow` is a scale about the block centre: 1 is exactly the block, 1.18 sticks out 0.09 blocks a side.
  const { plates = false, maxQuads = 0, lift = 0.004, maxLift = 0.08, grow = 1 } = opts;
  const cellAt = typeof cells?.cell === 'function' ? (i) => cells.cell(i) : (i) => cells?.[i];
  const stream = new VertexStream(4096, { indexed: true });
  // emitQuad picks a pass out of an array by sprite kind (opaque / cutout / translucent). A marker wants
  // all three in one stream, so all three names point at the same stream.
  const trio = [stream, stream, stream];
  // emitQuad keeps its own counters; this scratch object is where they land.
  const inner = { cubes: 0, quads: 0, faces: 0, culled: 0, skipped: 0, air: 0, unknown: 0, placeholder: 0, darkCulled: 0, buried: 0, covered: 0 };

  const stats = {
    rows: order.length, markers: 0, cubes: 0, plates: 0, models: 0, unknown: 0, air: 0,
    noCell: 0, noModel: 0, faces: 0, quads: 0, verts: 0, tris: 0, stopped: false, bytes: 0,
  };
  const mSec = new Uint32Array(order.length);
  const mEnd = new Uint32Array(order.length);
  const mRow = new Int32Array(order.length);
  const mCx = new Int32Array(order.length);
  const mCz = new Int32Array(order.length);
  let m = 0;

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (maxQuads && stats.quads >= maxQuads) { stats.stopped = true; break; }
    const c = cellAt(tl.cellOf(i));
    if (!c || c.cx === undefined || c.cz === undefined) { stats.noCell++; continue; }
    const bx = c.cx * 16 + tl.x(i), wz = c.cz * 16 + tl.z(i), y = tl.y(i);
    const name = tl.nameOf(i);
    const st = name ? (byName.get(name) ?? 0) - 1 : -1;
    const v0 = stream.n, i0 = stream.i;
    if (st >= 0 && st < assets.states.length && assets.stateAir[st] === 1) { stats.air++; continue; }
    if (st < 0 || st >= assets.states.length) {
      stats.unknown++;
      continue;                                       // named by the log, unknown to the atlas
    }
    const state = assets.states[st];
    const h = hash3(bx, y, wz);
    if (state.cube?.length) {
      const arm = state.cube[assets.pickArm(state, h)];
      for (const f of (plates ? TOP_ONLY : ALL_FACES)) {
        const [texIdx] = decodeFaceCode(arm[f]);
        const cell = assets.texCell(texIdx);
        if (!cell) { inner.skipped++; continue; }
        // occ / AOL / lit / LUT all null: a marker is a flat-shaded sprite cube. It is not in the world's
        // light field - it is a claim about the log, and it has to be readable inside a cave.
        emitCubeFace(stream, cell, arm[f], bx, y, wz, 0, 0, f, state, null, null, null, null);
        stats.faces++;
      }
      stats[plates ? 'plates' : 'cubes']++;
    } else if (state.g?.length) {
      const arm = state.g[assets.pickArm(state, h)];
      for (const qi of arm) {
        emitQuad(assets, trio, state, qi, bx, y, wz, FAKE_CHUNK, NO_AT, 0, 0, inner, null, null, null, null, -1, null);
        stats.faces++;
      }
      stats.models++;
    } else { stats.noModel++; continue; }
    const emitted = stream.i - i0;
    if (!emitted) { stats.noModel++; continue; }      // a fully transparent model draws nothing

    // Wash + a hair of lift. Repeats of one voxel (place, break, place again) would otherwise be coplanar
    // with each other; the page's material polygon-offsets the whole layer against the world's own faces,
    // which is what stops a marker z-fighting with the block it is standing on.
    const wash = ACTION_WASH[tl.action[i]] ?? ACTION_WASH[6];
    const liftY = Math.min(maxLift, ((seen0(bx, y, wz) ?? 0) * lift));
    const mx = bx + 0.5, my = y + 0.5, mz = wz + 0.5;
    for (let v = v0; v < stream.n; v++) {
      stream.col[v * 4] = (stream.col[v * 4] * wash[0]) | 0;
      stream.col[v * 4 + 1] = (stream.col[v * 4 + 1] * wash[1]) | 0;
      stream.col[v * 4 + 2] = (stream.col[v * 4 + 2] * wash[2]) | 0;
      if (grow !== 1) {
        const p = v * 3;
        stream.pos[p] = mx + (stream.pos[p] - mx) * grow;
        stream.pos[p + 1] = my + (stream.pos[p + 1] - my) * grow;
        stream.pos[p + 2] = mz + (stream.pos[p + 2] - mz) * grow;
      }
      if (liftY) stream.pos[v * 3 + 1] += liftY;
    }
    stats.quads += emitted / 6;
    mSec[m] = tl.sec[i]; mEnd[m] = stream.i; mRow[m] = i; mCx[m] = c.cx; mCz[m] = c.cz; m++;
    stats.markers = m;
  }

  const done = stream.done();
  stats.verts = done.count;
  stats.tris = done.tris;
  stats.bytes = done.position.byteLength + done.uv.byteLength + done.color.byteLength
    + (done.index ? done.index.byteLength : 0);
  stats.modelQuads = inner.quads;
  stats.skipped = inner.skipped;
  return {
    pos: done.position, uv: done.uv, col: done.color, idx: done.index,
    markerSec: mSec.subarray(0, m), markerEnd: mEnd.subarray(0, m), markerRow: mRow.subarray(0, m),
    markerCx: mCx.subarray(0, m), markerCz: mCz.subarray(0, m),
    stats,
  };
}

/**
 * Repeat counting for the sub-millimetre lift. Rebuilding this per build (rather than carrying it between
 * builds) is deliberate: `?timelook=blocks` and `?timecls=2` are different marker sets, and a lift carried
 * over from one to the other would make a marker's height depend on which filter ran first.
 */
const _seen = new Map();
function seen0(x, y, z) {
  const key = (x + 2097152) * 17179869184 + (y + 4096) * 4194304 + (z + 2097152);
  const n = _seen.get(key) ?? 0;
  _seen.set(key, n + 1);
  if (_seen.size > 4_000_000) _seen.clear();          // a scrub that outlives the map must not grow it
  return n;
}

/** Reset the repeat map. The page calls it at the top of every rebuild. */
export const resetMarkerLift = () => _seen.clear();

/**
 * Which marker a raycast index hit. `hit.index` counts INDICES, and the geometry is one indexed mesh, so
 * this is a binary search over the per-marker cumulative index counts.
 */
export function markerOfIndex(markerEnd, index) {
  let lo = 0, hi = markerEnd.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index < markerEnd[mid]) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

/** How many MARKERS a playhead covers. `quadAt` answers in quads; this answers in markers. */
export function markerAt(markerSec, sec) {
  let lo = 0, hi = markerSec.length, n = 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (markerSec[mid] <= sec) { n = mid + 1; lo = mid + 1; } else hi = mid;
  }
  return n;
}
