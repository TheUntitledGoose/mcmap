// Heightmap shell frames (M5). A shell is the cheapest thing that still looks like terrain: four
// u16 per column instead of ~100 KB of voxel payload. The far view is built from these; the near view
// keeps full voxel data so filtering/X-ray stay possible.
//
// One column stores four numbers because the far view has to answer two different questions and a
// single height cannot answer both:
//   surface / cover  what the eye meets from far away - treetops, plants, the skin of a lake
//   ground  / state  what to *paint* it with - a solid, opaque block, i.e. the ground under a flower,
//                    the bed under 22 blocks of water, the soil under a canopy
import { openChunk } from './chunk-payload.mjs';
import {
  SHELL_MAGIC, SHELL_VERSION, SHELL_HEADER, SHELL_COLS, SHELL_COLS_BYTES, SHELL_LIGHT_BYTES,
  SHELL_BAND_BYTES, HEIGHT_BIAS,
} from '../shared/chunk-format.mjs';
import { packLight } from '../shared/light.mjs';

export const SHELL_FRAME =
  SHELL_HEADER + SHELL_COLS * SHELL_COLS_BYTES + SHELL_LIGHT_BYTES + SHELL_BAND_BYTES;
// Struct of arrays, so the two height planes and the two state planes each compress as a run.
export const SHELL_H = 0, SHELL_C = 1, SHELL_G = 2, SHELL_S = 3;
const ARR = SHELL_COLS * 2;
const LIGHT_OFF = SHELL_HEADER + 4 * ARR;
const BAND_OFF = LIGHT_OFF + SHELL_COLS;

/**
 * Collapse a decoded chunk payload into a shell frame.
 *
 * The surface height comes straight from WORLD_SURFACE, which counts leaves and plants: that is the
 * silhouette the eye actually sees from far away, and MOTION_BLOCKING would hide modded tree canopies
 * (Regions Unexplored writes leaves that do not block motion).
 *
 * The paint state is the first block at or under the surface that is solid *and* opaque. "Solid"
 * alone is not enough: water is a full cube, and painting a lake with the water sprite is what made
 * the far view read as one flat sheet of paint with a hard square seam where the full-detail water
 * (see-through, right down to the bed) took over. Non-solid blocks - flowers, grass, signs, panes -
 * are skipped the same way, over a short drop, so a meadow paints grass rather than a cross sprite.
 *
 * @param {Buffer} bytes a packed chunk payload
 * @param {{maxDrop?: number, maxWaterDrop?: number, isPaint?: (id:number)=>boolean,
 *          isSolid?: (id:number)=>boolean, isCube?: (id:number)=>boolean}} [opts]
 *        `isPaint` = solid and opaque (what a column may be painted with); `isSolid` = solid, possibly
 *        see-through (water). `isCube` is accepted as an old alias for `isPaint`.
 */
export function shellFromPayload(bytes, opts = {}) {
  const hasSky = opts.hasSky !== false;
  const c = openChunk(bytes);
  if (!c.height) return null;
  const maxDrop = opts.maxDrop ?? 5;          // a flower sits one or two blocks above its ground
  const maxWaterDrop = opts.maxWaterDrop ?? 40;  // an ocean bed can be that far below its surface
  // A tree canopy can sit 25 blocks above the forest floor, and the floor is what the far view has to
  // stand its cell on. Stopping at the first solid block finds the *trunk top* instead, and a cell then
  // stands as a solid column one cell wide and 25 blocks tall: a tree that looks like a tower.
  const maxVegDrop = opts.maxVegDrop ?? 40;
  const isPaint = opts.isPaint ?? opts.isCube ?? null;
  const isSolid = opts.isSolid ?? null;
  // A film (water, ice, glass) holds a surface up but is not a skin: the film rule already draws it at
  // the water line, and counting 39 blocks of lake as "skin" would ask for a 39-block cap box.
  const isFilm = opts.isFilm ?? null;

  const h = new Uint16Array(SHELL_COLS);      // surface height (biased)
  const cover = new Uint16Array(SHELL_COLS);  // state at that height
  const g = new Uint16Array(SHELL_COLS);      // top of the paint block (biased)
  const s = new Uint16Array(SHELL_COLS);      // paint state
  const li = new Uint8Array(SHELL_COLS);      // sky|blk light on the column's surface
  const bd = new Uint8Array(SHELL_COLS);      // thickness of the solid run that starts at the surface
  h.set(c.height);
  /**
   * Is this block part of a surface, or is it a spike? A trunk is paintable, opaque and a full cube, so
   * "is it solid?" cannot tell a tree from the ground - and a player's log wall must still count as the
   * thing it is made of. The structural test does: a surface has paintable material beside it *at its own
   * level*, a pillar has air or leaves. (Two columns down the contour of a hillside always touch the same
   * level, so a slope passes; a ridge one block wide does not, and it falls back to the old answer.)
   * Only blocks inside this chunk are known, and that is honest: across the border the neighbouring
   * chunk decides for itself.
   */
  const onSurface = (x, y, z) => {
    let n = 0, known = 0;
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue;
      known++;
      const b = c.stateAt(nx, y, nz);
      if (b && isPaint(b)) n++;
    }
    return n >= Math.min(2, known);
  };

  for (let i = 0; i < SHELL_COLS; i++) {
    const x = i & 15, z = i >> 4;
    const top = c.height[i] - HEIGHT_BIAS;
    const at = c.stateAt(x, top, z);
    cover[i] = at;
    let paint = 0, py = top;
    if (isPaint) {
      const seeThru = !!(at && isSolid && isSolid(at));
      if (at && isPaint(at)) {
        paint = at;                                 // the surface block is itself the ground
      } else {
        // The block at the top is a hat: a plant, a pane, a canopy, water. Two separate answers are
        // needed, and the old code used one for both:
        //   what to paint with  - the first paintable block under the hat, usually one or two down;
        //   what to stand on    - the first paintable block that is *attached* to its own level (see
        //     onSurface), which for a tree is the forest floor and not the top of its trunk.
        // Standing a far cell on the trunk top is what made a tree a solid column: a tower.
        const limit = seeThru ? maxWaterDrop : maxVegDrop;
        let surf = 0, first = 0;
        for (let k = 1; k <= limit; k++) {
          const below = c.stateAt(x, top - k, z);
          if (!below || !isPaint(below)) continue;
          if (!first && (seeThru || k <= maxDrop)) first = top - k;
          if (surf || !onSurface(x, top - k, z)) continue;
          surf = top - k;
          break;
        }
        py = surf || first || py;
        if (first) paint = c.stateAt(x, first, z);
        else if (py !== top) paint = c.stateAt(x, py, z);
      }
    } else {
      paint = at;                              // no classifier: paint whatever is on top
    }
    if (!paint) { paint = at; py = top; }      // never leave a column unpaintable
    s[i] = paint;
    g[i] = py + HEIGHT_BIAS;
    li[i] = columnLight(c, x, top, z, hasSky);
    // How thick is the skin? `height` and `ground` between them say a canopy tops the column and the
    // forest floor stands under it, but not whether the gap is twenty blocks of leaves or one trunk.
    // That is the difference between a green roof with an underside you can see and a tower, so the
    // run of see-through full cubes starting at the surface block gets measured once, here.
    //
    // "See-through" is the whole trick: a trunk is solid *and* paintable, so a contiguous-solid test
    // walks straight down a tree's trunk into the ground and reports nothing interesting. Leaves are
    // full cubes that may not paint a cell, so counting them from the surface down to the first block
    // that may paint gives the canopy's own thickness. A hillside starts with grass, which may paint,
    // and costs one test. The walk never goes below the ground the column stands on.
    //
    // A film stops the run too. Without that, a lake column reports the water's depth as its skin - the
    // deepest bands in this world were 39 blocks of water over a gravel bed - and a canopy with a stream
    // running through it measures the water as part of its own thickness.
    if (isSolid && isPaint && at && isSolid(at) && !isPaint(at)) {
      const room = Math.min(254, top - py + 1);
      let k = 0;
      while (k < room) {
        const b = c.stateAt(x, top - k, z);
        if (!b || !isSolid(b) || isPaint(b) || (isFilm && isFilm(b))) break;
        k++;
      }
      bd[i] = k;
    }
  }

  return frame(c.cx, c.cz, h, cover, g, s, li, bd);
}

/**
 * What light falls on this column, sampled in the air one above its surface. The surface block
 * itself stores no light (a solid's cells are dark in the save), and the far layer paints the skin
 * of the column, so the number that matters is the light arriving at it.
 *
 * A section with neither a light array nor a Starlight marker reports LIGHT_UNKNOWN; the only
 * honest fallback is the dimension rule the payload decoder already uses: open sky where the
 * dimension has skylight at all, and never in the nether.
 */
function columnLight(c, x, top, z, hasSky) {
  for (const y of [top + 1, top]) {
    let [sky, blk] = c.lightAt(x, y, z);
    if (sky < 0 && blk < 0) continue;
    if (sky > 15) sky = hasSky ? 15 : 0;
    if (blk > 15) blk = 0;
    return packLight(Math.max(0, sky), Math.max(0, blk));
  }
  return packLight(hasSky ? 15 : 0, 0);
}

/** Pack four u16 column planes, one light byte and one surface-band byte into a shell frame. */
function frame(cx, cz, h, cover, g, s, light, band) {
  const out = Buffer.alloc(SHELL_FRAME);
  out.write(SHELL_MAGIC, 0, 'ascii');
  out.writeUInt16LE(SHELL_VERSION, 8);
  out.writeUInt16LE(0, 10);                    // flags: none yet
  out.writeInt16LE(cx, 12);
  out.writeInt16LE(cz, 14);
  const at = (plane) => SHELL_HEADER + plane * ARR;
  Buffer.from(h.buffer, h.byteOffset, ARR).copy(out, at(SHELL_H));
  Buffer.from(cover.buffer, cover.byteOffset, ARR).copy(out, at(SHELL_C));
  Buffer.from(g.buffer, g.byteOffset, ARR).copy(out, at(SHELL_G));
  Buffer.from(s.buffer, s.byteOffset, ARR).copy(out, at(SHELL_S));
  if (light) Buffer.from(light.buffer, light.byteOffset, SHELL_COLS).copy(out, LIGHT_OFF);
  if (band) Buffer.from(band.buffer, band.byteOffset, SHELL_COLS).copy(out, BAND_OFF);
  return out;
}

/**
 * Re-assemble a shell frame from stored columns. Shell packs keep exactly these planes, so
 * a pack read becomes a frame without touching NBT at all.
 */
export function shellFrameCols(cx, cz, h, cover, g, s, light, band) {
  return frame(cx, cz, h, cover, g, s, light, band);
}

/** The column planes of a shell frame, as views over its bytes. */
export function shellPlanes(buf, off = 0) {
  const ab = buf.buffer ?? buf;
  const base = (ab === buf ? 0 : buf.byteOffset) + off + SHELL_HEADER;
  const plane = (k) => new Uint16Array(ab, base + k * ARR, SHELL_COLS);
  const light = new Uint8Array(ab, base + 4 * ARR, SHELL_COLS);
  const band = new Uint8Array(ab, base + 4 * ARR + SHELL_COLS, SHELL_COLS);
  return {
    h: plane(SHELL_H), cover: plane(SHELL_C), g: plane(SHELL_G), state: plane(SHELL_S),
    light, band,
  };
}
