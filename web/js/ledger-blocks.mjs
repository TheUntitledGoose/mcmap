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
// Why a later claim at one voxel is drawn OUTSIDE the earlier ones (the `stackGrow` option): a voxel that was
// placed and later broken has two markers, and both used to be the same size, so they fought for the same
// pixels. One raycast measured who won - the older placement, meaning the page answered a click about a block
// that had already left, and a person saw green and red occupying one block. Markers at a voxel are now scaled
// about the block centre by how many claims came before them at that voxel, so the newest claim is always the
// outermost shell: it encloses the claims it supersedes, wins the pixel, and answers the click. The ramp
// saturates (a voxel here is logged 292 times, and a linear rule would build a 30-metre tower out of it), and
// it moves almost nothing else: measured over the baked overworld timeline (build/dbg-voxelstack.mjs), 6.8% of
// its 313,884 claimed voxels hold more than one claim at all, and p99 holds one.
//
// Two honest limits:
//   A row whose block name the atlas does not know (entity kills, item actions, mod objects that were never
//   baked) has no shape to draw. They are counted in `stats.unknown` and, when the atlas has a placeholder
//   sprite, drawn as that placeholder rather than silently dropped.
//   Six faces per marker is six times the tiles. `maxQuads` degrades a whole build from cubes to plates
//   (top face only, still the block's own texture) and then stops, and the caller prints the number.

import { emitCubeFace, emitQuad, hash3, VertexStream } from './mesher.js';
import { decodeFaceCode } from '../../shared/cube-path.mjs';
import { DIRS, FACE_DIR } from '../../shared/faces.mjs';

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

/** The step to the voxel on the other side of face f, in the same DIRS order the mesher uses. */
const FACE_OFF = DIRS.map((d) => FACE_DIR[d]);

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
 * Why a face inside the build is not drawn (the `cull` option: 1 = at the moment of the claim, which is the
 * default; 2 = anywhere in the filter; 0 = never): the world's own mesher throws away a face whose neighbour
 * is solid, and a marker layer that does not is a wall of panels you can see straight through. Measured over
 * the densest placement chunk in the shipped overworld pack
 * (build/dbg-markermass.mjs - the deepslate-brick wall at x -48..-33, z -128..-113 this was reported on):
 * **60% of its 12,432 marker faces sit against another claimed voxel of the same filter**, so three in five
 * faces point into the interior of the thing the players built. Seen through the gaps in the near skin those
 * back-faces read as "the normals are inverted and I see the opposite faces". Culling them is also cheaper:
 * that chunk's cubes drop from 6 faces each to their own outer skin.
 *
 * Why "is the other side claimed" is a question about WHEN (build/dbg-prefixskip.mjs, the run that found
 * this): answered for the whole filter at once, the shipped overworld any-change filter loses 1,006,431 of
 * 2,109,186 faces - and **442,673 of those were buried by a neighbour whose claim comes LATER than the row
 * being drawn**. 211,882 markers lost at least one face they should still show, and 20,148 of them lost all
 * six and drew nothing at all. So a face is inside the build only from the second its other side entered it.
 * The stale faces that rule keeps are not visible anyway: once the neighbour exists, the camera-near side of
 * that neighbour covers this face from every viewpoint (the camera sits outside whatever it sees, and an
 * entry face is never culled), so a stale face costs fill and never paints wrong, while culling it early
 * leaves a see-through block at every earlier second.
 *
 * Why a model is NOT scaled about the block centre: a cube needs `grow` so it stops being coplanar with the
 * block it describes. An authored model needs no such thing, and cannot survive it - the census allows geometry
 * outside the 0..16 box, and a marker for `soulsweapons:chungus_monolith` already reaches ~2 blocks from its
 * voxel, so multiplying that reach by the grow factor put it nearly 3 blocks off the grid. The model's own
 * shape is the claim, so `?timegrow` belongs to cubes.
 *
 * Why one voxel draws EVERY claim it has (the `dedupe` option, off by default): it used to keep only the
 * newest claim, on the theory that the newest is the block standing there at the playhead. That is true only
 * at the END of the filter. Measured over the shipped overworld any-change filter
 * (build/dbg-prefixskip.mjs 0): of the voxels that had a claim at or before a given playhead, 1,801 of them
 * drew NOTHING at that second, because the one claim the layer kept happened later. A block the log places,
 * absent from the picture - "some blocks are being skipped entirely". So every claim draws, and the RAY
 * decides who owns the pixel: `pickMarkerHit` takes the newest of the coplanar faces, which is the claim
 * true at the playhead. `?timededupe=1` restores one-marker-per-voxel (cheaper, and honest only once the
 * playhead is at the end of the filter).
 *
 * Why the ramp and dedupe cannot both be on: the ramp's whole point is that a later claim sits OUTSIDE an
 * earlier one, which needs several markers at one voxel. Dedupe is therefore implied whenever the ramp is on.
 * Neither is the default: the ramp reaches past the voxel edge (270 of 1,910 markers up to 0.36 blocks into a
 * neighbour in the reported chunk), and same-size nesting answers the click by buffer order instead.
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
  // `stackGrow` is the outward reach, in blocks, that the saturated stack ramp adds on top of `grow`;
  // 0 restores same-size markers, which is the A/B. `stackTau` is how many claims at one voxel it takes to
  // get most of the way there.
  const { plates = false, maxQuads = 0, lift = 0.004, maxLift = 0.08, grow = 1,
    stackGrow = 0, stackTau = 3, cull = 1, dedupe = false } = opts;
  const ramp = stackGrow > 0 ? stackGrow : 0;
  const keepLast = ramp > 0 ? false : dedupe;
  const cullAll = cull === 2 || cull === 'all';
  const cullAny = !!cull;
  // Strictly increasing in the number of claims already drawn at this voxel, and bounded: the newest claim at
  // a voxel is always the outermost shell, and even a voxel logged 292 times stays inside grow + 2*stackGrow.
  const sizeOf = (depth) => grow + 2 * (ramp > 0 ? ramp * (1 - Math.exp(-depth / stackTau)) : 0);
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
    stacked: 0, maxStack: 0, culled: 0, enclosed: 0, deduped: 0, repeats: 0, deepest: 0,
  };
  // When each voxel FIRST entered this filter, as a position in `order`: a face is inside the build only from
  // that second onward. The same pass remembers the NEWEST claim at each voxel for the opt-in dedupe.
  const firstClaim = cullAny ? new Map() : null;
  const newest = keepLast ? new Map() : null;
  let kq = 0;
  for (const i of order) {
    const c = cellAt(tl.cellOf(i));
    if (!c || c.cx === undefined || c.cz === undefined) continue;
    const key = vkey(c.cx * 16 + tl.x(i), tl.y(i), c.cz * 16 + tl.z(i));
    if (firstClaim && !firstClaim.has(key)) firstClaim.set(key, kq);
    if (newest) newest.set(key, kq);
    kq++;
  }
  const claims0 = new Map();
  const mSec = new Uint32Array(order.length);
  const mEnd = new Uint32Array(order.length);
  const mRow = new Int32Array(order.length);
  const mCx = new Int32Array(order.length);
  const mCz = new Int32Array(order.length);
  const mRep = new Uint16Array(order.length);   // how many earlier claims of this voxel this one supersedes
  let m = 0;

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (maxQuads && stats.quads >= maxQuads) { stats.stopped = true; break; }
    const c = cellAt(tl.cellOf(i));
    if (!c || c.cx === undefined || c.cz === undefined) { stats.noCell++; continue; }
    const bx = c.cx * 16 + tl.x(i), wz = c.cz * 16 + tl.z(i), y = tl.y(i);
    const key = vkey(bx, y, wz);
    // How many claims of this voxel came before this one - the repeat count the card answers with, and the
    // depth the stack ramp scales by when someone asks for a ramp.
    const depth0 = claims0.get(key) ?? 0;
    claims0.set(key, depth0 + 1);
    // One voxel, one block: a claim this filter supersedes draws no geometry of its own. Opt-in, and honest
    // only at the end of the filter - see the header.
    if (newest && newest.get(key) !== k) { stats.deduped++; continue; }
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
    let hid = 0;
    const hidden = (f) => {
      if (!firstClaim) return false;
      const d = FACE_OFF[f];
      const n = firstClaim.get(vkey(bx + d[0], y + d[1], wz + d[2]));
      return n !== undefined && (cullAll || n <= k);
    };
    if (state.cube?.length) {
      const arm = state.cube[assets.pickArm(state, h)];
      for (const f of (plates ? TOP_ONLY : ALL_FACES)) {
        if (hidden(f)) { hid++; stats.culled++; continue; }
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
    if (!emitted) { if (hid === (plates ? 1 : 6)) stats.enclosed++; else stats.noModel++; continue; }      // a fully transparent model draws nothing

    // Wash + a hair of lift. Repeats of one voxel (place, break, place again) would otherwise be coplanar
    // with each other; the page's material polygon-offsets the whole layer against the world's own faces,
    // which is what stops a marker z-fighting with the block it is standing on.
    const wash = ACTION_WASH[tl.action[i]] ?? ACTION_WASH[6];
    // One counter answers both questions about this voxel: how many claims were drawn here before (which
    // sets the lift) and therefore whose turn it is in the stack (which sets how far out it reaches).
    const depth = ramp > 0 ? (seen0(bx, y, wz) ?? 0) : depth0;
    // The lift only exists to separate markers that share a voxel. With one marker per voxel there is nothing
    // to separate, and a block lifted 0.08 off its grid square is exactly the "waaaay off grid" complaint:
    // the material's polygon-offset is what keeps a flush marker off the terrain's own depth value.
    const liftY = ramp ? Math.min(maxLift, depth * lift) : 0;
    // Cubes only: an authored model's reach IS the block's shape, and scaling it about the voxel centre
    // turns a big block into a wrong one (see the header).
    const g = state.cube?.length ? (depth && ramp ? sizeOf(depth) : grow) : 1;
    const mx = bx + 0.5, my = y + 0.5, mz = wz + 0.5;
    for (let v = v0; v < stream.n; v++) {
      stream.col[v * 4] = (stream.col[v * 4] * wash[0]) | 0;
      stream.col[v * 4 + 1] = (stream.col[v * 4 + 1] * wash[1]) | 0;
      stream.col[v * 4 + 2] = (stream.col[v * 4 + 2] * wash[2]) | 0;
      if (g !== 1) {
        const p = v * 3;
        stream.pos[p] = mx + (stream.pos[p] - mx) * g;
        stream.pos[p + 1] = my + (stream.pos[p + 1] - my) * g;
        stream.pos[p + 2] = mz + (stream.pos[p + 2] - mz) * g;
      }
      if (liftY) stream.pos[v * 3 + 1] += liftY;
    }
    if (depth) { stats.stacked++; if (depth + 1 > stats.maxStack) stats.maxStack = depth + 1; }
    mRep[m] = Math.min(65535, depth);
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
    markerRepeat: mRep.subarray(0, m),
    stats,
  };
}

/**
 * One voxel key, shared by the repeat counter and the inside-the-build face test.
 *
 * A string, and that is not laziness: the usual trick of packing x,y,z into one float (`(x+2^21)*2^34 +
 * (y+2^12)*2^22 + (z+2^21)`) needs 56 bits, and a double is exact below 2^53. Out here it already is not:
 * the magnitude is ~2^55, so the spacing is 8 and a z of 2, 3 or 4 collapses to ONE number. That is how a
 * cube marker for a lone block lost its north and south faces to a neighbour that does not exist, and it is
 * also why a block claimed once can come back with a stack depth of 10 and get scaled like a tenth claim.
 */
function vkey(x, y, z) { return `${x},${y},${z}`; }

/**
 * Of the faces a click ray hit, the one that owns the pixel. A voxel logged N times is N cubes of the same
 * size standing on one 1x1x1, so the ray meets N coplanar faces at a single distance and three.js returns
 * them in buffer order - oldest claim first. Taking the FIRST of those answers a block that has already left
 * (measured before the draw-range work: the oldest claim won 36 of 36 shared pixels), and dropping the other
 * claims to dodge it leaves the earlier seconds with no block at all. So: newest claim wins, buffer order
 * decides, and `eps` is how close two hits have to be to count as the same pixel.
 */
export function pickMarkerHit(hits, eps = 1e-3) {
  let best = null;
  for (const h of hits) {
    if (!best || h.distance < best.distance - eps) best = h;
    else if (h.distance <= best.distance + eps && h.faceIndex > best.faceIndex) best = h;
  }
  return best;
}

/**
 * Repeat counting for the sub-millimetre lift. Rebuilding this per build (rather than carrying it between
 * builds) is deliberate: `?timelook=blocks` and `?timecls=2` are different marker sets, and a lift carried
 * over from one to the other would make a marker's height depend on which filter ran first.
 */
const _seen = new Map();
function seen0(x, y, z) {
  const key = vkey(x, y, z);
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
