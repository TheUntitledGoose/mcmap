// Meshing for the heightmap shell (M5). A shell chunk is 256 columns, each with a top height and a
// block state; this turns those into a solid-looking skin: one top quad per column plus a skirt down
// to whichever neighbour is lower. Unlike the detail mesher there are no interior faces to cull, so
// the whole cost is the surface itself — which is what makes it affordable at distance.
//
// `cell` decimates: cell 4 emits one column per 4x4 block cell, and the column it keeps is the
// 80th percentile of the cell's heights, not the tallest. Tallest means one tree, or one chimney,
// decides the height of a 64 m cell and hangs a skirt over the village around it; the mean buries the
// roof under the yard. The percentile keeps the roofline, which is what the eye calls the skyline.
// Cell sizes must divide 16, so a cell never straddles a chunk border and both sides of a border
// agree on the grid.
import { VertexStream, FACE_SHADE, CUBE, tintOf } from './mesher.js';
import { HEIGHT_BIAS } from '../../shared/chunk-format.mjs';
import { decodeFaceCode, cubeFaceUV, RING_ORDER } from '../../shared/cube-path.mjs';
import { lightLut, rampAt, combineLight, skyOf, blkOf } from '../../shared/light.mjs';

const FACES = ['down', 'up', 'north', 'south', 'west', 'east'];

/** A full cube the eye sees straight through - water, glass, ice. A surface, never the terrain. */
/**
 * Is this state a full block, i.e. does the column's own surface height *belong* to it?
 *
 * Water, leaves, a canopy: a full cube, so WORLD_SURFACE is the top of something that fills the column
 * and the silhouette is real. A grass tuft, a fern, bamboo, a fence: not a full block, so the surface
 * height marks the top of sparse geometry, and standing a solid column on it invents a tower. This asks
 * about shape, not see-through-ness, because "is it transparent?" was the wrong question: vanilla oak
 * leaves paint from an opaque sprite, yet a canopy is exactly the silhouette we want to keep.
 */
function isFullBlock(assets, id) {
  if (!id || !assets.stateCube) return false;
  return assets.stateCube[id - 1] === 1;
}

/** A full block the eye sees through - water, ice, glass. Paint the block under it, then film over it. */
function isSeeThrough(assets, id) {
  if (!isFullBlock(assets, id)) return false;
  return assets.stateOpaque[id - 1] === 0;
}

/**
 * Does this state deserve a film over the cell - water, ice, a slime block - rather than being painted
 * as itself? Only a translucent sprite (atlas kind 2) qualifies. isSeeThrough would also answer yes for
 * leaves and other cutouts, which measure as non-opaque because their sprite has holes: that turned
 * every forest in the far view into a canopy laid over its own ground, and cost a second quad per cell.
 */
function isFilm(assets, id) {
  if (!id) return false;
  if (assets.stateFilm) return assets.stateFilm[id - 1] === 1;
  return isSeeThrough(assets, id);          // an atlas with no kind data: fall back to the old rule
}

/**
 * Which state paints a cell. The bake picked one with an *opaque* cube test, and leaves measure as
 * non-opaque (their sprite has holes), so every forest in the far view painted its trunks and threw
 * its canopy away: a field of brown stumps where the truth is white magnolia tops. Shape, not
 * transparency, is the right question here: if the cover is a full cube and the eye does not see
 * through it the way it sees through water, the cover *is* the surface and deserves the colour.
 */
function paintFor(assets, coverId, groundId) {
  if (coverId && coverId !== groundId && isFullBlock(assets, coverId) && !isFilm(assets, coverId)) return coverId;
  return groundId;
}

/**
 * The height a coarse cell stands at. `height` is what the eye sees from far away (a lake skin, a
 * canopy); `ground` is the top of the solid block that paints the cell. Where the cell's cover is a
 * plane the eye sees *through*, keep the plane: it is the surface, and dropping the cell to the lake
 * bed would punch a hole in the world. Everywhere else use the ground, because the skirt a coarse
 * cell hangs under itself is geometry the eye reads, and a 30 block dirt cliff under a spruce tree is
 * a lie. Cell 1 never hangs a skirt, so it keeps the real silhouette.
 */
function colHeight(assets, sh, k, cell, groundFar) {
  const h = sh.height[k];
  if (!h || !sh.ground || !groundFar) return h;
  if (isFullBlock(assets, sh.cover ? sh.cover[k] : 0)) return h;
  const g = sh.ground[k];
  return g > 0 && g < h ? g : h;
}
// face index, and the horizontal step toward the neighbour that would hide this wall
const WALLS = [[2, 0, -1], [3, 0, 1], [4, -1, 0], [5, 1, 0]];

/**
 * Sprite per face for one state, memoised. `{cell, code}` where `code` is a cube face code
 * (texture * 8 + uv transform); quad-path states fall back to their first usable sprite with the
 * identity transform, which is the best a 2-pixel-wide far column can ask for.
 */
// exported for tests: which sprite answers "what colour is face f of this column"
export function faceSprites(assets, stateId, cache) {
  const e = cache.get(stateId);
  if (e) return e;
  const state = assets.states[stateId - 1];
  const out = new Array(6).fill(null);
  const put = (f, texIndex, uvT = 0) => {
    const cell = assets.texCell(texIndex);
    if (!cell || cell.kind === 3) return;
    out[f] = { cell, code: (texIndex << 3) | (uvT & 7) };
  };
  if (state.cube) {
    const arm = state.cube[0];            // one arm per state: the variant lottery is invisible at shell scale
    for (let f = 0; f < 6; f++) { const [tex, uvT] = decodeFaceCode(arm[f]); put(f, tex, uvT); }
  } else if (state.g?.length) {
    let any = -1;
    for (const qi of state.g[0]) {
      // quad refs come in pairs: geometry index, then tex 0..11 | (dir+1)<<12 | cullface | flags
      const pk = assets.ref[qi * 2 + 1];
      const tex = pk & 0xfff;
      const dir = ((pk >> 12) & 7) - 1;
      const cell = assets.texCell(tex);
      if (!cell || cell.kind === 3) continue;
      any = tex;
      if (dir >= 0 && !out[dir]) put(dir, tex, 0);
    }
    // A model with no axis-aligned faces (a slanted modded shape) still has to answer "what colour is
    // the top of this column", so fall back to whatever it does draw.
    if (any >= 0) for (let f = 0; f < 6; f++) if (!out[f]) put(f, any, 0);
  }
  cache.set(stateId, out);
  return out;
}

/**
 * Colour per face, memoised per state: the sprite's own mean colour, shaded. At shell scale a column
 * is a couple of pixels wide, so per-texel sampling just shatters into noise — the sprite mean is what
 * those pixels average to anyway, and it stays readable at any distance. (This is also why the shell
 * material carries no map: see main.js.)
 *
 * The atlas stores `c` as sRGB bytes because that is what an image editor and a minimap both want,
 * but a vertex colour attribute is read as linear light, so convert here. No AO: shell columns are a
 * few pixels wide and the height silhouette already carries the shape.
 */
function faceColors(assets, state, per, shade, cache, tex = false, mul = 1, lkey = '') {
  // Memoised per state *and per light level*: colour used to be a property of the state alone, but
  // a shaded far layer paints the same grass bright in a field and dark in a ravine, so the cache
  // key has to carry the level. Levels are integers 0..15, so the table stays small.
  const ck = (tex ? 'T' : 'F') + state.k + lkey;
  const e = cache.get(ck);
  if (e) return e;
  const emissive = (state.l ?? 0) / 15 * 0.9;
  const out = FACE_SHADE.map((s, f) => {
    const cell = per[f]?.cell ?? per[1]?.cell;
    const c = cell?.c ?? GREY;
    // the same grey-mask gate the detail mesher uses: the mean of a mask is grey, it needs the tint
    const tint = state.ti && cell?.g ? tintOf(state) : WHITE;
    // mul is the far layer's one concession to the pass it has to blend into: the close-up pass
    // darkens every corner by ambient occlusion and the far layer has no corners to darken. Measured
    // over real chunks (tools/dbg-aomean.mjs, 460k verts) that is a mean factor of 0.931, so a far quad
    // sits about 7% brighter than the same block meshed close up - the ground lightening again at the
    // detail ring, which is the other half of the seam the far layer exists to hide. Emissive blocks are
    // left alone: nothing darkens a light source.
    const m = Math.max(s * shade * mul, emissive);
    // A textured quad takes its colour from the sprite, so its vertex colour carries only what the
    // detail pass multiplies the sprite *by* - face shade and tint. Painting the sprite mean over the
    // sprite as well applies it twice; that doubling is the seam between the far layer and the near
    // one at the edge of the detail ring.
    const lin = tex ? () => 1 : srgbToLinear;
    // 0..1 floats: VertexStream.tri multiplies by 255 on the way into the u8 attribute.
    return [
      lin(c[0] / 255) * tint[0] * m,
      lin(c[1] / 255) * tint[1] * m,
      lin(c[2] / 255) * tint[2] * m,
      1,
    ];
  });
  cache.set(ck, out);
  return out;
}

const _LM = { m: 1, key: '' };
/**
 * How bright this column's own slice of the save's light makes the cell.
 *
 * The far layer used to be a flat-bright map: the same lake, the same cliff, the same nether roof as
 * the detail pass, only never dark. The two layers therefore disagreed exactly where they met, and
 * the nether read as noon. One packed light byte per column (server/shell.mjs, sampled in the air
 * above the surface) is a twelfth of the frame's size and buys the same shading, with the same curve
 * and the same cave-brightness / daylight controls the detail pass uses.
 *
 * Returns {m, key} rather than a number: `key` is the discrete light level, which the colour cache
 * needs to separate its entries.
 */
function lightOf(light, k, ctx) {
  if (!light || !ctx.lut) { _LM.m = 1; _LM.key = ''; return _LM; }
  const b = light[k] ?? 0;
  const lv = combineLight(skyOf(b), blkOf(b), ctx.skyScale);
  _LM.m = rampAt(ctx.lut, lv);
  _LM.key = 'l' + lv;
  return _LM;
}

const GREY = [136, 136, 136];
const WHITE = [1, 1, 1];
// The same curve three.js uses to get a texture out of sRGB; keeping it here lets the flat shell read
// like the textured detail pass instead of like a washed out version of it.
function srgbToLinear(v) { return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }

// A cell's height is a quantile of its columns, not its maximum — the same rule
// `overviewFromPacks` uses across chunks, for the same reason. Measured in DarkRPG at 2976 68 2007:
// somebody built a floating wheat farm (farmland + stone + spruce, y 233..243) on top of an ocean
// (y 62) with 169 blocks of air in between (chunk 208,143). Tallest-column decimation let that one
// column speak for its cell and painted a 181-block cliff wall down to the sea floor, which read as
// a striped mountain standing in the middle of a flat sea.
export const CELL_PCTL = 0.8;

// Quantile of the first n entries of `a`. A cell is at most 8x8 columns, so sorting beats being
// clever; the result only decides which column speaks for the cell.
function quantile(a, n, p) {
  const t = [];
  for (let i = 0; i < n; i++) t.push(a[i]);
  t.sort((x, y) => x - y);
  return t[Math.min(n - 1, Math.floor(n * p))];
}

function patchCtx(assets, opts) {
  const cell = Math.max(1, Math.min(16, opts.cell | 0 || 1));
  // LOD by distance: a chunk near the camera keeps its 1x1 columns while a far one collapses to 8x8.
  // The grid stays chunk-anchored and the cell size always divides 16, so borders still line up.
  const cellFor = opts.cellFor ?? (() => cell);
  const ctx = {
    stream: new VertexStream(opts.cap ?? 8192),
    stats: { columns: 0, walls: 0, noSprite: 0 },
    maxSkirt: opts.maxSkirt ?? 32,
    shade: opts.shade ?? 1,
    cell,
    // How much a decimated cell may borrow its neighbours' colour instead of the tallest column's
    // own. `?blend=0` keeps the strict "mean colour of that one sprite" rule.
    blend: opts.blend ?? 1,
    sum: new Float64Array(24),
    hs: new Int32Array(256),      // scratch: heights of one cell
    nh: new Int32Array(256),      // scratch: heights of one neighbour side
    mix: Array.from({ length: 6 }, () => [0, 0, 0, 1]),
    cellFor: (cx, cz) => Math.max(1, Math.min(16, cellFor(cx, cz) | 0 || 1)),
    // The lake skin: a cell painted with its bed still gets the cover laid back over it, at the
    // alpha the detail pass really draws it at, so far water and near water agree on the colour.
    waterOpacity: opts.waterOpacity === undefined ? 0.72 : +opts.waterOpacity,
    groundFar: opts.groundFar === undefined ? 1 : +opts.groundFar,
    sprites: new Map(),
    colors: new Map(),
    // Probes need to check a pixel against the block the mesher *chose* for that quad, which after
    // decimation is the tallest column of the cell and not necessarily the column under the ray.
    // Recording one state id per quad (2 bytes) is what makes that check possible.
    // Two paints, chosen per cell. Flat is a plate of the sprite's mean colour: stable when a cell is
    // a couple of pixels wide, and the only way a 72% water film can be expressed at all, since the
    // textured material is the cutout family and has no partial alpha. Textured draws the sprite
    // itself, which is what makes far ground read as ground rather than as a colour swatch.
    tex: !!opts.tex,
    aoFar: opts.aoFar === undefined ? 1 : opts.aoFar,
    // light curve shared with the detail pass (shared/light.mjs), so a far column and a close one
    // of the same block agree; null when lighting is off, which restores the old flat look exactly
    lut: opts.lightOn === false ? null
      : lightLut(+(opts.darkFloor ?? 0.32), +(opts.darkGamma ?? 0.72)),
    skyScale: opts.skyScale === undefined ? 1 : +opts.skyScale,
    idsMain: opts.trackStates ? [] : null,
    out: null,
    stateIds: null,
    curId: 0,
    assets,
  };
  // Route the quads of one cell to the stream their paint belongs in. Both streams carry the same
  // attributes; only the material differs, so the caller builds one mesh per stream.
  ctx.to = (stream, ids) => { ctx.out = stream; ctx.stateIds = ids; };
  ctx.to(ctx.stream, ctx.idsMain);
  return ctx;
}

/**
 * One rectangle face. The unit corner ring is stretched to `cell` blocks horizontally and `yLo..yHi`
 * vertically; every corner of ring `f` already sits at an extreme of both in-plane axes, so that affine
 * map is exact. Corners are visited in RING_ORDER so the quad faces outward, with uv looked up by the
 * same ring index — that pairing is what keeps the sprite the right way up.
 */
function emitRect(ctx, f, wx, wz, yLo, yHi, span, spr, col) {
  const ring = CUBE[f];
  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const uv = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const { u0, v0, u1, v1 } = spr.cell;
  for (let i = 0; i < 4; i++) {
    const k = RING_ORDER[f][i];
    p[i][0] = wx + ring[k][0] * span;
    p[i][1] = yLo + ring[k][1] * (yHi - yLo);
    p[i][2] = wz + ring[k][2] * span;
    const [su, sv] = cubeFaceUV(spr.code, k);
    uv[i][0] = u0 + su * (u1 - u0);
    uv[i][1] = v0 + sv * (v1 - v0);
  }
  ctx.out.quad(p[0], p[1], p[2], p[3], uv, col);
  if (ctx.stateIds) ctx.stateIds.push(ctx.curId);   // one entry per quad, same order as the stream
}

/**
 * Columns of one shell chunk into `ctx`. `topAt(wx,wz)` resolves an *absolute* block column to a top
 * block y (or null for "unknown"), so the caller can answer across chunk borders.
 */
/**
 * How far a decimated cell may drift toward the mean colour of its neighbours. The cell's own sprite
 * has to stay the majority, otherwise a coarse cell of `minecraft:stone` next to a forest turns
 * green and the probe can no longer recognise its own blocks. Kept under 0.5 for that reason.
 */
export const blendFor = (cell) => Math.min(0.35, 0.15 * (cell - 1));

function meshColumns(assets, shell, ctx, topAt) {
  const { stats, maxSkirt, shade } = ctx;
  const cell = ctx.cellFor(shell.cx, shell.cz);
  // A 4x4 cell drawn in one bright sprite reads as TV static from 300 blocks up: one ore block or one
  // canopy leaf cube speaks for sixteen. Blend the cell toward the mean colour of the columns that
  // share the tallest column's height band, so a treetop stays green instead of borrowing the dirt
  // under it, and a lone bright block stops flickering across the patch.
  const blend = blendFor(cell);
  // The wall has to stop at the *neighbour cell's* top face, and after LOD that cell can be a
  // different size from ours, so walk the neighbour side, resolve each column to its own
  // chunk-anchored cell, and take that cell's tallest column. Unknown anywhere still means unknown.
  const neighTop = (wx, wz, dx, dz) => {
    let n = 0;
    const seen = new Set();
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const bx = wx + dx * cell + i, bz = wz + dz * cell + j;
        const ncx = Math.floor(bx / 16), ncz = Math.floor(bz / 16);
        const cn = ctx.cellFor(ncx, ncz);
        const ox = Math.floor(((bx - ncx * 16)) / cn) * cn, oz = Math.floor(((bz - ncz * 16)) / cn) * cn;
        const ck = ((ncx + 512) * 1024 + (ncz + 512)) * 256 + oz * 16 + ox;
        if (seen.has(ck)) continue;
        seen.add(ck);
        for (let q = 0; q < cn; q++) {
          for (let r = 0; r < cn; r++) {
            const v = topAt(ncx * 16 + ox + r, ncz * 16 + oz + q);
            if (v === null) return null;
            ctx.nh[n++] = v;
          }
        }
      }
    }
    return n ? quantile(ctx.nh, n, CELL_PCTL) : null;
  };

  const hs = ctx.hs;
  for (let z0 = 0; z0 < 16; z0 += cell) {
    for (let x0 = 0; x0 < 16; x0 += cell) {
      // The quantile column decides both height and sprite, so one spike (a floating platform, a
      // lone tree, a beacon beam) cannot drag a whole cell up to its roof and hang a wall below it.
      let n = 0, wet = 0, wetId = 0, wetDepth = 0;
      for (let j = 0; j < cell; j++) {
        for (let i = 0; i < cell; i++) {
          const k = ((z0 + j) << 4) + (x0 + i);
          hs[n++] = colHeight(assets, shell, k, cell, ctx.groundFar);
          // How much of this cell is actually water, and how deep is the deepest part of it? One
          // column cannot answer either question for a 16x16 cell: a lake cell whose lucky sample
          // column happens to be a reef used to paint a sand square in the middle of the lake.
          const cv = shell.cover ? shell.cover[k] : 0;
          if (cv && isFilm(assets, cv)) {
            wet++;
            const d = (shell.height[k] ?? 0) - (shell.ground ? shell.ground[k] : (shell.height[k] ?? 0));
            if (d > wetDepth) { wetDepth = d; wetId = cv; }
          }
        }
      }
      const cellWet = wet * 2 >= cell * cell;
      const want = quantile(hs, n, CELL_PCTL);
      let bestH = -1, bestI = 0, gap = Infinity;
      for (let j = 0; j < cell; j++) {
        for (let i = 0; i < cell; i++) {
          const k = ((z0 + j) << 4) + (x0 + i);
          const hk = colHeight(assets, shell, k, cell, ctx.groundFar);
          const g = Math.abs(hk - want);
          if (g < gap) { gap = g; bestH = hk; bestI = k; }
        }
      }
      const gid = shell.state[bestI];
      const cid0 = shell.cover ? shell.cover[bestI] : 0;
      const id = paintFor(assets, cid0, gid);
      const stem = id !== gid ? gid : 0;          // a canopy paints its top; the wall is its trunk
      if (!id || bestH < 0) continue;
      const state = assets.states[id - 1];
      if (!state) continue;
      ctx.curId = id;
      const per = faceSprites(assets, id, ctx.sprites);
      if (!per[1]) { stats.noSprite++; continue; }
      // The film is folded into the cell's colour in both paints. It is not worth its price as real
      // geometry: measured over this lake at 1.5 km, a translucent quad per water cell took the far
      // layer from 3.6 M to 12.0 M verts, and the water sprite minified over an 8-16 block quad rings
      // like a pond surface seen through a mesh - moire across the whole lake.
      const lm = lightOf(shell.light, bestI, ctx);
      const mul = ctx.aoFar * lm.m;
      let col = faceColors(assets, state, per, shade, ctx.colors, ctx.tex, mul, lm.key);
      // Paint the bed, then lay the lake skin back over it. The far view used to paint water as a
      // solid sheet, so a lake changed character hard-edged at the edge of the detail ring: blue
      // sheet outside, see-through water with the bottom showing inside.
      const covId = cellWet && wetId ? wetId : (shell.cover ? shell.cover[bestI] : 0);
      const filmId = covId && covId !== id && ctx.waterOpacity > 0 && isFilm(assets, covId) ? covId : 0;
      if (filmId) {
        const cp = faceSprites(assets, covId, ctx.sprites);
        if (cp && cp[1]) {
          const cc = faceColors(assets, assets.states[covId - 1], cp, shade, ctx.colors, false, mul, lm.key);
          const tc = cp[1].cell;
          const one = ctx.waterOpacity * (tc && tc.a ? tc.a : 1);
          // One surface, whatever the depth. The detail pass culls water-to-water faces, so a 27 m lake
          // is drawn as a single translucent quad over the bed - and a far lake has to be the same
          // single quad, or the same lake changes character at the edge of the detail ring. That is the
          // discontinuity this whole file exists to remove, so it must not be reintroduced as alpha:
          // depth belongs to the geometry (the water line stays at `height`), not to the colour.
          const a = Math.min(0.99, one);
          for (let f = 0; f < 6; f++) for (let q = 0; q < 3; q++) {
            ctx.mix[f][q] = col[f][q] * (1 - a) + cc[f][q] * a;
          }
          col = ctx.mix;
        }
      }
      // Neighbour blending averages sprite *means*, which means nothing once the sprite is drawn -
      // and blurring the wrong colours over a texture is worse than not blending at all.
      if (blend > 0 && ctx.blend !== 0 && !ctx.tex) {
        const band = bestH - Math.max(2, cell);
        const S = ctx.sum.fill(0);
        let n = 0;
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            const k = ((z0 + j) << 4) + (x0 + i);
            if (k === bestI || colHeight(assets, shell, k, cell, ctx.groundFar) < band) continue;
            const cid = shell.state[k];
            const cs = cid ? assets.states[cid - 1] : null;
            if (!cs) continue;
            const cp = faceSprites(assets, cid, ctx.sprites);
            if (!cp[1]) continue;
            const cc = faceColors(assets, cs, cp, shade, ctx.colors, false, ctx.aoFar);
            for (let f = 0; f < 6; f++) { for (let q = 0; q < 4; q++) S[f * 4 + q] += cc[f][q]; }
            n++;
          }
        }
        if (n) {
          const w = blend * (n / (n + 1));
          for (let f = 0; f < 6; f++) {
            for (let q = 0; q < 3; q++) {
              ctx.mix[f][q] = col[f][q] * (1 - w) + (S[f * 4 + q] / n) * w;
            }
          }
          col = ctx.mix;
        }
      }
      const wx = shell.cx * 16 + x0, wz = shell.cz * 16 + z0;
      // A canopy paints its roof with leaves and its sides with whatever holds them up. Painting the
      // stem leaf-coloured is what made the far forest read as a field of floating cubes: the wall is
      // the trunk, and the trunk has its own sprite and its own colour.
      let wallPer = per, wallCol = col;
      if (stem && assets.states[stem - 1]) {
        const gp = faceSprites(assets, stem, ctx.sprites);
        if (gp && gp[1]) {
          wallPer = gp;
          wallCol = faceColors(assets, assets.states[stem - 1], gp, shade, ctx.colors, false, mul, lm.key);
        }
      }
      // The heightmap counts the top block, so the column is a cube sitting one below it.
      const yTop = bestH - HEIGHT_BIAS + 1;
      emitRect(ctx, 1, wx, wz, yTop - 1, yTop, cell, per[1], col[1]);
      stats.columns++;
      for (const [f, dx, dz] of WALLS) {
        const nt = neighTop(wx, wz, dx, dz);
        // Unknown neighbour (no shell loaded past the edge) still gets a skirt, or the edge of the
        // loaded area reads as a cliff that is not there.
        const yLo = nt === null ? yTop - maxSkirt : Math.min(yTop, nt + 1);
        if (yLo >= yTop) continue;
        emitRect(ctx, f, wx, wz, yLo, yTop, cell, wallPer[f] ?? wallPer[1], wallCol[f]);
        stats.walls++;
      }
    }
  }
}

/** Trim each stream and hang its own per-quad state ids off it, if they are being tracked. */
function finish(ctx) {
  const seal = (s, ids) => { const o = s.done(); if (ids) o.stateIds = Uint16Array.from(ids); return o; };
  return { stream: seal(ctx.stream, ctx.idsMain), stats: ctx.stats };
}

/**
 * Mesh one shell chunk.
 * @param {{nb?: (cx:number,cz:number)=>object|null, cell?: number,
 *          maxSkirt?: number, shade?: number, cap?: number}} [opts]
 *   nb: neighbour *shell frame* (or null when absent). Absent neighbours keep a skirt.
 */
export function meshShell(assets, shell, opts = {}) {
  const ctx = patchCtx(assets, opts);
  const nb = opts.nb ?? null;
  const topAt = (wx, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const sh = (cx === shell.cx && cz === shell.cz) ? shell : (nb ? nb(cx, cz) : null);
    return sh ? colHeight(assets, sh, ((wz & 15) << 4) | (wx & 15),
      (cx === shell.cx && cz === shell.cz) ? ctx.cell : ctx.cellFor(cx, cz),
      ctx.groundFar) - HEIGHT_BIAS : null;
  };
  meshColumns(assets, shell, ctx, topAt);
  return finish(ctx);
}

/**
 * Mesh a whole rectangle of shell chunks as one stream. Neighbouring columns share edges, so the
 * patch drops the wall between equal-height neighbours and keeps one draw call per patch instead of
 * per chunk. Absent chunks are simply skipped; their neighbours keep a skirt.
 */
export function meshShellPatch(assets, get, cx0, cz0, w, h, opts = {}) {
  const ctx = patchCtx(assets, opts);
  const skip = opts.skip ?? null;
  const topAt = (wx, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const sh = get(cx, cz);
    return sh ? colHeight(assets, sh, ((wz & 15) << 4) | (wx & 15),
      ctx.cellFor(cx, cz), ctx.groundFar) - HEIGHT_BIAS : null;
  };
  for (let cz = cz0; cz < cz0 + h; cz++) {
    for (let cx = cx0; cx < cx0 + w; cx++) {
      const sh = get(cx, cz);
      // Where the full voxel mesh already draws a chunk, leave it out of the skin: two surfaces at
      // exactly the same height z-fight. `topAt` still reads the skipped shell, so the neighbour
      // walls stay sealed and no cliff opens at the handover border.
      if (sh && !(skip && skip(cx, cz))) meshColumns(assets, sh, ctx, topAt);
    }
  }
  return finish(ctx);
}

export { FACES };

/**
 * The whole-dimension overview: one quad per coarse cell instead of one per chunk column. Same colour
 * rules as the shell skin (sprite mean + tint + face shade), because consistency between the two layers
 * matters more than extra detail nobody can see from 20 km up.
 *
 * @param ov {{w,h,x0,z0,cell,height:Uint16Array,state:Uint16Array}} as parsed by openOverview.
 * @param opts {{skip?: (cx:number,cz:number)=>boolean, cap?: number, trackStates?: boolean,
 *               minStep?: number, row0?: number, rows?: number}} - `skip` leaves out cells the chunk
 *               skin already paints, and `minStep` is the height difference below which no cliff wall
 *               is drawn (the overview grid is 64 blocks wide, so a one-block step would be a comb of
 *               invisible walls). `row0`/`rows` mesh one horizontal band of the grid, which is how the
 *               renderer fills a 100 000 cell grid in over a few frames instead of one long hitch.
 */
export function meshOverview(assets, ov, opts = {}) {
  const ctx = patchCtx(assets, opts);
  const span = ov.cell * 16;
  const skip = opts.skip ?? null;
  const minStep = opts.minStep ?? 2;
  const j0 = opts.row0 ?? 0;
  const j1 = Math.min(ov.h, j0 + (opts.rows ?? ov.h));
  const wof = (i, j) => j * ov.w + i;
  // Same rule as the skin: a lake skin stays at lake height, a canopy drops to the ground that
  // actually paints the cell.
  const H = (i, j) => (i < 0 || j < 0 || i >= ov.w || j >= ov.h) ? -32768
    : colHeight(assets, { height: ov.height, ground: ov.ground, cover: ov.cover },
      wof(i, j), ov.cell, ctx.groundFar) - HEIGHT_BIAS;
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < ov.w; i++) {
      const st0 = ov.state[j * ov.w + i];
      if (!st0) continue;
      const st = paintFor(assets, ov.cover ? ov.cover[wof(i, j)] : 0, st0);
      if (!st) continue;
      const cx = ov.x0 + i * ov.cell, cz = ov.z0 + j * ov.cell;
      // Counted, not just skipped: "the coarse layer is still covering the fine one" and "the coarse
      // layer left a hole" look identical in a screenshot, and the difference is this number.
      if (skip && skip(cx, cz)) { ctx.stats.skipped = (ctx.stats.skipped ?? 0) + 1; continue; }
      const h = H(i, j);
      if (h < -1024) continue;                       // nothing baked here
      const per = faceSprites(assets, st, ctx.sprites);
      if (!per[1]) { ctx.stats.noSprite++; continue; }
      const lm = lightOf(ov.light, wof(i, j), ctx);
      const mul = ctx.aoFar * lm.m;
      let col = faceColors(assets, assets.states[st - 1], per, ctx.shade, ctx.colors, false, mul, lm.key);
      const covId = ov.cover ? ov.cover[wof(i, j)] : 0;
      if (covId && covId !== st && ctx.waterOpacity > 0 && isFilm(assets, covId)) {
        const cp = faceSprites(assets, covId, ctx.sprites);
        if (cp && cp[1]) {
          const cc = faceColors(assets, assets.states[covId - 1], cp, ctx.shade, ctx.colors, false, mul, lm.key);
          const tc = cp[1].cell;
          const one = ctx.waterOpacity * (tc && tc.a ? tc.a : 1);
          // Same single film as the skin, so a lake does not darken again at the overview level.
          const a = Math.min(0.99, one);
          for (let f = 0; f < 6; f++) for (let q = 0; q < 3; q++) {
            ctx.mix[f][q] = col[f][q] * (1 - a) + cc[f][q] * a;
          }
          col = ctx.mix;
        }
      }
      const wx = cx * 16, wz = cz * 16, y = h + 1;
      ctx.curId = st;
      emitRect(ctx, 1, wx, wz, y, y, span, per[1], col[1]);
      ctx.stats.columns++;
      for (const [f, dx, dz] of WALLS) {
        const nh = H(i + dx, j + dz);
        if (nh < -1024 || h - nh < minStep) continue;   // unknown or flat: no wall
        emitRect(ctx, f, wx + (dx > 0 ? span : 0), wz + (dz > 0 ? span : 0),
          nh + 1, y, span, per[f] ?? per[1], col[f]);
        ctx.stats.walls++;
      }
    }
  }
  return finish(ctx);
}
