// Voxel -> triangle mesher. DOM-free and three-free: it emits plain typed arrays that
// web/js/main.js hands to THREE.BufferGeometry, so the whole meshing path is unit-testable
// in Node against real chunk payloads.
//
// Conventions
//   * world coordinates are Minecraft's: +X east, +Y up, +Z south (three.js matches).
//   * a chunk covers x,z in [0,16) locally; block y is absolute world y.
//   * `assets` state indices are the chunk payload's global state id minus one
//     (worldd numbers them from atlas.json order, so the mapping is a subtraction).
//   * three output buckets, one per texture class: 0 opaque, 1 cutout, 2 translucent.

import { FACE_INFO } from '../../shared/faces.mjs';
import { CANON_RING, RING_ORDER, decodeFaceCode, cubeFaceUV } from '../../shared/cube-path.mjs';
import { lightLut, rampAt } from '../../shared/light.mjs';
import { HEIGHT_BIAS } from '../../shared/chunk-format.mjs';

/**
 * What the neighbour callback answers for "nobody holds that chunk, but the far layers already paint
 * its ground". A face pointing at it is hidden by the heightmap skin on the other side, so drawing it
 * costs a quad and shows nothing - which is exactly the wall of dirt a chunk boundary grows around an
 * unloaded neighbour, visible as the sides of a hole when nothing is missing at all.
 */
export const NEIGH_COVERED = -2;

// Unit-cube corners per direction, from CANON_RING's "x,y,z" strings (model units 0..16).
export const CUBE = CANON_RING.map((ring) =>
  ring.map((s) => {
    const [x, y, z] = s.split(',').map(Number);
    return [x / 16, y / 16, z / 16];
  }));

// Vanilla's directional shading: top brightest, then N/S, then W/E, bottom darkest.
export const FACE_SHADE = [0.55, 1.0, 0.8, 0.8, 0.62, 0.62];

// Per-corner occlusion, 0 = tucked into a corner up to 3 = wide open. DarkRPG ships no light
// arrays (Starlight strips them), so this is the only depth cue available and it is worth the
// three extra neighbour lookups per corner.
export const AO_LEVEL = [0.42, 0.62, 0.82, 1.0];
// Vanilla's darkest corner sits near 0.4, but vanilla multiplies by skylight on top of that and
// we have no light at all: 0.42 * 0.62 side shade = a quarter of the texel, which reads as a
// burnt black seam where blocks meet. Raising the floor keeps the shape cue without the soot.
export function aoLevels(min) {
  if (!(min > 0) || min >= 1) return AO_LEVEL;
  return [min, min + (1 - min) / 3, min + (2 * (1 - min)) / 3, 1];
}

const AXIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Per direction: the axis the face points along, plus the two axes it spans. uA/vA are kept as
// axis *indices* as well as vectors, because stepping one cell along an in-plane axis is a one-line
// index write and the shading loop does it four times per corner.
const FACE_AXES = FACE_INFO.map((info) => {
  const other = [0, 1, 2].filter((a) => a !== info.axis);
  return {
    nA: info.axis, nS: info.sign > 0 ? 1 : -1,
    u: AXIS[other[0]], v: AXIS[other[1]], uA: other[0], vA: other[1],
  };
});

// Which way each cube-face corner sits along the two in-plane axes (±1). The occlusion
// samples hang off the cell just outside the face, in those directions.
const CORNER_OFF = CUBE.map((ring, fi) =>
  ring.map((c) => {
    const off = [0, 0, 0];
    for (let a = 0; a < 3; a++) if (a !== FACE_AXES[fi].nA) off[a] = c[a] > 0.5 ? 1 : -1;
    return off;
  }));

/**
 * Occlusion and smooth light for one face corner.
 *
 * AO level 0..3 for the corner comes from the two edge neighbours and the diagonal of the block
 * layer just outside the face. Two blocked edges means the corner is fully tucked in, which
 * is what stops the shading reading as hard squares.
 *
 * `lx/lz` are chunk-local (they may step outside 0..15 at a border — `occ` resolves that),
 * while `y` is absolute, matching the neighbour callback's convention.
 */
/** Scratch for cornerShade - it runs four times per quad and must not allocate. */
const _CS = [0, 0];

/**
 * Occlusion and smooth light for one face corner, written into `_CS` as [aoLevel, lightLevel].
 *
 * Both need the same cells: the one the face looks into, and the two edge neighbours plus the
 * diagonal around this corner. AO turns those three into 0..3 ("two blocked edges means the corner
 * is tucked in"), smooth light averages all four - the cell the face looks into included - which is
 * what lets a torch pool fade across block boundaries instead of stepping.
 *
 * `lx/lz` are chunk-local and may step outside 0..15 at a border (both callbacks resolve that);
 * `y` is absolute. When a probe lands in a chunk nobody has loaded, the corner falls back to the
 * light of the air cell this face looks into, and only if even that is unknown to the voxel's own
 * cell: a real save stores 0 in the solid block itself, so using it first paints a dark seam down
 * every chunk border.
 *
 * Each in-plane axis carries its own sign: multiplying both axes by `off[0]`, as this function used
 * to, sampled the wrong pair of diagonal cells for half of the corners.
 */
function cornerShade(occ, lit, own, lx, y, lz, fi, off) {
  const ax = FACE_AXES[fi];
  const px = lx + (ax.nA === 0 ? ax.nS : 0);
  const py = y + (ax.nA === 1 ? ax.nS : 0);
  const pz = lz + (ax.nA === 2 ? ax.nS : 0);
  const su = off[ax.uA], sv = off[ax.vA];
  const p1 = [px, py, pz]; p1[ax.uA] += su;
  const p2 = [px, py, pz]; p2[ax.vA] += sv;
  const p3 = [px, py, pz]; p3[ax.vA] += sv; p3[ax.uA] += su;
  if (occ) {
    const s1 = occ(p1[0], p1[1], p1[2]);
    const s2 = occ(p2[0], p2[1], p2[2]);
    if (s1 && s2) _CS[0] = 0;
    else _CS[0] = 3 - (s1 + s2 + occ(p3[0], p3[1], p3[2]));
  } else _CS[0] = 3;
  if (lit) {
    // An opaque block keeps light 0 in its own cell, so the stand-in for an unresolved probe has to
    // be the air the face looks into, not the voxel being drawn: falling back to the voxel's own
    // level turns every chunk border into a black seam.
    const here = lit(px, py, pz);
    const base = here >= 0 ? here : own;
    const g = (x, yy, z) => { const v = lit(x, yy, z); return v < 0 ? base : v; };
    _CS[1] = (Math.max(0, here) + g(p1[0], p1[1], p1[2]) + g(p2[0], p2[1], p2[2]) + g(p3[0], p3[1], p3[2])) * 0.25;
  } else _CS[1] = 15;
  return _CS;
}

/**
 * Growable vertex stream.
 *
 * Two shapes. Non-indexed (the default, and what the far layers use): a quad is six vertices, two
 * triangles that do not share their diagonal. Indexed (`{ indexed: true }`, what the detail pass
 * asks for): a quad is four vertices and six indices, which is 33 % of the vertex bytes back per
 * face, measured 40 % once neighbouring faces also share corners - and it is cheaper to write, not
 * dearer, because the two shared corners are written once. See HANDOFF 9.5: the vertex bill is what
 * a chunk costs in memory and upload, and indexing is the part of that bill with no rules attached
 * to it. A merged run of faces would be the rest, and it is not here because it costs CPU to find
 * and needs uv tiling in the shader.
 */
export class VertexStream {
  constructor(cap = 4096, opts = {}) {
    this.indexed = !!opts.indexed;
    this.pos = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Uint8Array(cap * 4);      // shade * tint, sent as normalized u8
    this.idx = this.indexed ? new Uint32Array(cap * 6) : null;
    this.i = 0;                              // indices written
    this.n = 0;
  }
  get bytes() { return this.n * 9 + this.i * 4; }
  #grow(need) {
    if (this.n + need <= this.pos.length / 3) return;
    let cap = this.pos.length / 3;
    while (cap < this.n + need) cap *= 2;
    const p = new Float32Array(cap * 3); p.set(this.pos.subarray(0, this.n * 3)); this.pos = p;
    const u = new Float32Array(cap * 2); u.set(this.uv.subarray(0, this.n * 2)); this.uv = u;
    const c = new Uint8Array(cap * 4); c.set(this.col.subarray(0, this.n * 4)); this.col = c;
    if (this.idx) {
      const x = new Uint32Array(cap * 6); x.set(this.idx.subarray(0, this.i)); this.idx = x;
    }
  }
  /** one vertex, and its number */
  vert(a, b, c) {
    this.#grow(1);
    let o = this.n * 3;
    this.pos[o] = a[0]; this.pos[o + 1] = a[1]; this.pos[o + 2] = a[2];
    o = this.n * 2;
    this.uv[o] = b[0]; this.uv[o + 1] = b[1];
    o = this.n * 4;
    this.col[o] = (c[0] * 255) | 0; this.col[o + 1] = (c[1] * 255) | 0;
    this.col[o + 2] = (c[2] * 255) | 0; this.col[o + 3] = 255;
    return this.n++;                                 // the slot just written (n was the count before it)
  }
  /** six indices for a quad's two triangles, from its four vertex numbers */
  quadIdx(v0, v1, v2, v3, flip) {
    this.idx = this.idx ?? new Uint32Array(24);
    if (this.i + 6 > this.idx.length) {
      const x = new Uint32Array(this.idx.length * 2); x.set(this.idx); this.idx = x;
    }
    const o = this.i;
    if (flip) { this.idx[o] = v1; this.idx[o + 1] = v2; this.idx[o + 2] = v3; this.idx[o + 3] = v1; this.idx[o + 4] = v3; this.idx[o + 5] = v0; }
    else { this.idx[o] = v0; this.idx[o + 1] = v1; this.idx[o + 2] = v2; this.idx[o + 3] = v0; this.idx[o + 4] = v2; this.idx[o + 5] = v3; }
    this.i = o + 6;
  }
  tri(a, b, c) {                             // a,b,c = [x,y,z],[u,v],[r,g,b] floats 0..1
    this.#grow(1);
    let o = this.n * 3;
    this.pos[o] = a[0]; this.pos[o + 1] = a[1]; this.pos[o + 2] = a[2];
    o = this.n * 2;
    this.uv[o] = b[0]; this.uv[o + 1] = b[1];
    o = this.n * 4;
    this.col[o] = (c[0] * 255) | 0; this.col[o + 1] = (c[1] * 255) | 0;
    this.col[o + 2] = (c[2] * 255) | 0; this.col[o + 3] = 255;
    this.n++;
  }
  quad(p0, p1, p2, p3, uv, cols, flip = false) {  // uv = [u,v] per corner, matching corner order
    // cols: four per-corner colours, or one colour repeated across the quad
    const c = cols.length === 4 && Array.isArray(cols[0]) ? cols : [cols, cols, cols, cols];
    if (this.indexed) {
      this.quadIdx(this.vert(p0, uv[0], c[0]), this.vert(p1, uv[1], c[1]),
        this.vert(p2, uv[2], c[2]), this.vert(p3, uv[3], c[3]), flip);
      return;
    }
    // The two triangles must share the diagonal the corner shading fades along; picking the
    // other one leaves a hard wedge down the middle of the quad.
    if (flip) {
      this.tri(p1, uv[1], c[1]); this.tri(p2, uv[2], c[2]); this.tri(p3, uv[3], c[3]);
      this.tri(p1, uv[1], c[1]); this.tri(p3, uv[3], c[3]); this.tri(p0, uv[0], c[0]);
    } else {
      this.tri(p0, uv[0], c[0]); this.tri(p1, uv[1], c[1]); this.tri(p2, uv[2], c[2]);
      this.tri(p0, uv[0], c[0]); this.tri(p2, uv[2], c[2]); this.tri(p3, uv[3], c[3]);
    }
  }
  /** trim to used size, for handing to THREE without over-allocating */
  done() {
    const s = this.n;
    return {
      position: this.pos.subarray(0, s * 3),
      uv: this.uv.subarray(0, s * 2),
      color: this.col.subarray(0, s * 4),
      // null means the soup: `count` vertices, every three of them a triangle
      // 16-bit indices where the mesh fits: they are half the bytes, and at a 16 chunk ring the
      // index buffer is a tenth of the geometry. A 100k-vertex mesh (village, cave system) has to
      // stay 32-bit, and three reads the width off the array we hand it.
      index: this.idx
        ? (this.n < 65536 ? Uint16Array.from(this.idx.subarray(0, this.i)) : this.idx.subarray(0, this.i))
        : null,
      count: s,
      tris: (this.idx ? this.i : s) / 3,
    };
  }
}

const hash3 = (x, y, z) => {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return h >>> 0;
};

/**
 * Mesh one chunk.
 *
 * @param {Assets} assets
 * @param chunk           an opened chunk payload (web/js/payload.js)
 * @param {Function} at  (cx, cz, lx, ly, lz) -> atlas state index, -1 for unknown/ unloaded.
 *                       lx,lz may be outside 0..15 to reach across chunk borders.
 * @param {{ maxQuads?: number }} [opts]
 */
export function meshChunk(assets, chunk, at, opts = {}) {
  // The detail pass asks for indexed streams (`{ index: 1 }`): four vertices and six indices per
  // face instead of six vertices. Same triangles, same attributes, ~40 % of the vertex bytes back.
  const sio = opts.index ? { indexed: true } : {};
  const streams = [new VertexStream(4096, sio), new VertexStream(4096, sio), new VertexStream(4096, sio)];
  const stats = { cubes: 0, quads: 0, faces: 0, culled: 0, skipped: 0, air: 0, unknown: 0, placeholder: 0, darkCulled: 0, buried: 0, covered: 0 };
  const baseX = chunk.cx << 4, baseZ = chunk.cz << 4;
  const maxQuads = opts.maxQuads ?? Infinity;

  // palette slot -> atlas state index (-1 unknown). 0 in the payload means "unknown state".
  const pal = new Int32Array(chunk.palette.length);
  for (let i = 0; i < pal.length; i++) {
    const id = chunk.palette[i];
    pal[i] = id === 0 ? -1 : id - 1;
    if (pal[i] >= assets.states.length) pal[i] = -1;
  }

  // Neighbour state lookups go through `at`, which resolves across chunk borders.

  /**
   * 1 when a full opaque cube sits at that local position — an AO occluder. Null when AO is
   * switched off (?noao), which keeps a side-by-side comparison of the two looks possible.
   */
  const AOL = opts.ao === false ? null : aoLevels(+(opts.aoMin ?? 0.42));
  const occ = AOL ? (lx, yy, lz) => {
    const st = at(chunk.cx, chunk.cz, lx, yy, lz);
    return st >= 0 && assets.stateOpaque[st] === 1 ? 1 : 0;
  } : null;

  /**
   * Light comes from the save's own sky/block arrays (M6): `opts.light` mirrors `at` and answers a
   * combined 0..15 level for a coordinate that may sit in a neighbouring chunk, or -1 when nobody
   * has that chunk loaded. Null with `?nolight`, which leaves the unlit look available for A/B.
   */
  const LUT = opts.light ? lightLut(+(opts.darkFloor ?? 0.32), +(opts.darkGamma ?? 0.72)) : null;
  const lit = LUT ? (lx, yy, lz) => opts.light(chunk.cx, chunk.cz, lx, yy, lz) : null;

  /**
   * Dark-face culling, the BlueMap trick: a face whose air side receives no light is a face no
   * camera can ever see, and caves are where the vertex budget was going. `darkcut` is the highest
   * combined light level that still gets dropped, so -1 (or absent) means "mesh the caves too".
   *
   * Three rules keep it from eating geometry that is visible:
   *   - the test is the **air cell the face looks into**, never the voxel being drawn: an opaque
   *     block stores 0 light in its own cell, so testing that would delete every block in the save;
   *   - an **unknown** air value (-1: the neighbour chunk is not held, or the section says
   *     LIGHT_UNKNOWN) is kept, because a chunk that loads before its neighbours would otherwise
   *     grow holes that nothing ever comes back to fill;
   *   - a state that emits its own light (atlas `l`, e.g. glowstone, a torch's own quad) is kept.
   *
   * Deliberately independent of `darkFloor`: the ramp decides how dark unlit looks, not whether the
   * geometry exists. With the old flat look (darkFloor 1) this still drops the cave walls, which is
   * the whole point.
   */
  const DARKCUT = lit ? Math.min(15, +(opts.darkcut ?? -1)) : -1;
  const emits = (state) => (state.l ?? 0);

  /**
   * Buried faces: the second half of the same idea. A face in a lava pool 30 blocks down *is* lit -
   * by the lava - so the dark test lets it through, and no camera above ground will ever see it. The
   * honest discriminator is not depth on its own: a ravine is deep, wide open, and the first thing
   * you look at. It is depth **with no skylight in the air cell the face looks into**.
   *
   * So: the face's own chunk answers "is that air cell under my surface skin by at least `buried`
   * blocks?" from the heightmap it already carries (a subtract, no map lookup), and only the cells
   * that pass get one skylight probe. Open air, ravine walls and cave mouths have skylight and stay;
   * tunnels, caverns and lava pools have none and go. 0 switches the rule off, and like dark culling
   * it belongs to the "mesh unlit caves" switch: with caves on, nothing is culled.
   */
  const BURIED = DARKCUT >= 0 ? Math.max(0, Math.min(256, +(opts.buried ?? 0))) : 0;
  const HMAP = BURIED > 0 ? chunk.height : null;
  // How much skylight still counts as "this air cell is open to the world". Modded and Starlight
  // light fields are not tidy: a sealed cavern reads skylight 1-2 in places, and per-face that turns
  // a smooth cave wall into floating scraps. 0 (the old behaviour) demands total darkness.
  const SKYMAX = Math.max(0, Math.min(15, +(opts.buriedSky ?? 0)));
  const sky = BURIED > 0 && opts.sky ? (lx, yy, lz) => opts.sky(chunk.cx, chunk.cz, lx, yy, lz) : null;

  /**
   * A surface-only skin has to ask a taller question than "is this under the heightmap": WORLD_SURFACE
   * counts leaves and water, so that question erases the floor under a tree canopy and the bed of a
   * lake, and you see the sky through the gaps in the leaves. The honest question is "is there an
   * *opaque* block above the air this face looks into", and its answer is one number per column: the
   * highest opaque block. Walking for it is cheap because a chunk is mostly one state repeated - a
   * uniform section answers every column at once, and a mixed section stops at the first hit per
   * column, top down.
   */
  const SURF = opts.surfaceOnly ? 1 : 0;
  let OPQ = null;
  if (SURF) {
    const opq = new Int8Array(chunk.palette.length);
    for (let i = 0; i < opq.length; i++) {
      const st = chunk.palette[i] === 0 ? -1 : chunk.palette[i] - 1;
      opq[i] = st >= 0 && st < assets.states.length && assets.stateOpaque[st] === 1 ? 1 : 0;
    }
    OPQ = new Int16Array(256).fill(-0x7fff);
    const done = new Uint8Array(256);
    const secs = chunk.sections.slice().sort((a, b) => b.y - a.y);
    for (const s of secs) {
      const y0 = s.y << 4;
      if (s.single) {
        if (!opq[s.single - 1]) continue;                     // air, or glass: nothing hides anything
        for (let col = 0; col < 256; col++) if (!done[col]) { OPQ[col] = y0 + 15; done[col] = 1; }
        break;                                                // and that answers every column
      }
      for (let col = 0; col < 256; col++) {
        if (done[col]) continue;
        const x = col & 15, z = col >> 4;
        for (let k = 15; k >= 0; k--) {
          if (opq[s.vox[(k << 8) | (z << 4) | x]]) { OPQ[col] = y0 + k; done[col] = 1; break; }
        }
      }
    }
  }

  const buried = (BURIED > 0 || SURF)
    ? (nx, ny, nz) => {
      // Only this chunk's own column: the wrapped column of a neighbour would answer for the wrong
      // piece of ground, and an unknown column must never cull a face.
      if (nx < 0 || nx > 15 || nz < 0 || nz > 15) return false;
      // The skin answers first, and asks no light question at all: rock over the air cell means the
      // face is not on the surface, whatever the light down there says.
      if (SURF && OPQ[(nz << 4) | nx] > ny) return true;
      if (!HMAP || BURIED <= 0 || !sky) return false;
      const surf = HMAP[(nz << 4) | nx] - HEIGHT_BIAS;
      if (!(surf > -2000) || surf - ny < BURIED) return false;
      const sk = sky(nx, ny, nz);
      // Unknown means the air cell is outside the sections this chunk carries, i.e. the face sits on
      // a section border and the other side may well be open sky - keep it.
      return sk >= 0 && sk <= SKYMAX;
    }
    : null;

  for (const sec of chunk.sections) {
    const y0 = sec.y << 4;

    /**
     * One voxel: classify it, then emit whichever of its faces are not hidden. A closure so the
     * walk below can skip the inside of a uniform section without duplicating any of this - both
     * paths have to emit the same triangles in the same order, and a divergence there is a hole in
     * the world that only shows up underground.
     */
    const visit = (ly, lz, lx) => {
      const slot = sec.single ? sec.single - 1 : sec.vox[(ly << 8) | (lz << 4) | lx];
      const st = pal[slot];
      if (st < 0) { stats.unknown++; return; }
      if (assets.stateAir[st] === 1) { stats.air++; return; }
      const y = y0 + ly;
      const state = assets.states[st];
      const bx = baseX + lx, bz = baseZ + lz;
      const h = hash3(bx, y, bz);

      if (state.cube) {
        const arm = state.cube[assets.pickArm(state, h)];
        stats.cubes++;
        for (let f = 0; f < 6; f++) {
          const [texIdx, tr] = decodeFaceCode(arm[f]);
          const cell = assets.texCell(texIdx);
          if (!cell) { stats.skipped++; continue; }
          if (cell.kind === 3) stats.placeholder++;   // baked fallback sprite: a coverage hole
          const v = FACE_INFO[f].v;
          const nx = lx + v[0], nz = lz + v[2], ny = y + v[1];
          if (sec.single && nx >= 0 && nx < 16 && ny >= y0 && ny < y0 + 16 && nz >= 0 && nz < 16) {
            stats.culled++; continue;                // interior of a uniform section
          }
          const nb = at(chunk.cx, chunk.cz, nx, ny, nz);
          if (nb === NEIGH_COVERED) { stats.covered++; continue; }
          if (nb >= 0 && assets.stateOpaque[nb] === 1) { stats.culled++; continue; }
          // water/lava must not draw its internal faces; glass may (vanilla draws those)
          if (cell.kind === 2 && nb === st) { stats.culled++; continue; }
          if (DARKCUT >= 0) {
            const air = lit(nx, ny, nz);
            const ownL = lit(lx, y, lz);           // glass/leaves carry their own level; solids 0
            if (air >= 0 && air <= DARKCUT && emits(state) <= DARKCUT && !(ownL > DARKCUT)) {
              stats.darkCulled++; continue;
            }
          }
          if (buried && buried(nx, ny, nz)) { stats.buried++; continue; }
          emitCubeFace(streams[classify(cell.kind)], cell, arm[f], bx, y, bz, lx, lz, f, state, occ, AOL, lit, LUT);
          stats.faces++;
        }
      } else if (state.g?.length) {
        const arm = state.g[assets.pickArm(state, h)];
        stats.quads++;
        for (const qi of arm) {
          if (stats.quads > maxQuads) break;
          if (emitQuad(assets, streams, state, qi, bx, y, bz, chunk, at, lx, lz, stats, occ, AOL, lit, LUT, DARKCUT, buried)) stats.faces++;
        }
      } else stats.skipped++;
    };

    // A section that is one state repeated (half the sections in a surface chunk arrive that way -
    // the deepslate under every hill) can only ever show a face on the outside of its own
    // 16x16x16 box, because every interior neighbour is that same state. Walking the 1352 cells on
    // the box instead of all 4096 is the biggest cut in mesh cost available, and it is the same
    // walk order as the general case, so the triangles come out identical.
    // A section that is one state repeated (half the sections in a surface chunk arrive that way -
    // the deepslate under every hill) can only ever show a face on the outside of its own
    // 16x16x16 box, because every interior neighbour is that same state. Walking the 1352 cells on
    // the box instead of all 4096 is the biggest cut in mesh cost available, and it is the same
    // walk order as the general case, so the triangles come out identical. Only valid for a state
    // on the cube path: a repeated non-cube shape can show faces between two of its own blocks.
    const uniSlot = sec.single ? pal[sec.single - 1] : -1;
    if (uniSlot >= 0 && assets.stateAir[uniSlot] === 1) { stats.air += 4096; continue; }
    const shellOnly = uniSlot >= 0 && assets.states[uniSlot].cube !== undefined;
    for (let ly = 0; ly < 16; ly++) {
      const innerRow = shellOnly && ly > 0 && ly < 15;
      for (let lz = 0; lz < 16; lz++) {
        if (innerRow && lz > 0 && lz < 15) { visit(ly, lz, 0); visit(ly, lz, 15); continue; }
        for (let lx = 0; lx < 16; lx++) visit(ly, lz, lx);
      }
    }
  }

  return { streams: streams.map((s) => s.done()), stats };
}

function classify(kind) { return kind === 1 ? 1 : kind === 2 ? 2 : 0; }

/** vertex colour for a face: directional shade, emissive floor, and grass/leaves tint if flagged */
export function faceColor(out, shadeMul, emissive, tint) {
  const s = Math.max(shadeMul, emissive);
  out[0] = s * tint[0]; out[1] = s * tint[1]; out[2] = s * tint[2];
  return out;
}

const _col = [0, 0, 0];
const _col4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

function emitCubeFace(stream, cell, code, bx, y, bz, lx, lz, f, state, occ, AOL, lit, LUT) {
  // a mirrored/rotated face code uses the same corner ring, only the sprite uv moves. The *visit*
  // order is RING_ORDER, which is the one that winds the quad outward for a front-side renderer;
  // uv, corner offset and AO all follow the same ring index k so a sprite stays upright.
  // A tint only belongs on a sprite that really is a grey mask (atlas flag `g`): vanilla ships
  // grass_block_top grey but grass_block_side already brown, and mod sprites are authored in colour.
  const tint = state.ti && cell.g ? tintOf(state) : WHITE;
  const emissive = (state.l ?? 0) / 15 * 0.9;
  const ring = CUBE[f], order = RING_ORDER[f];
  const uv = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  // AO and the light field both multiply in; a block that emits its own light keeps its brightness.
  const own = lit ? Math.max(0, lit(lx, y, lz)) : 15;
  const cols = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let a01 = 0, a23 = 0;
  for (let i = 0; i < 4; i++) {
    const k = order[i];
    const [su, sv] = cubeFaceUV(code, k);
    uv[i][0] = cell.u0 + su * (cell.u1 - cell.u0);
    uv[i][1] = cell.v0 + sv * (cell.v1 - cell.v0);
    p[i][0] = bx + ring[k][0]; p[i][1] = y + ring[k][1]; p[i][2] = bz + ring[k][2];
    const sh = cornerShade(occ, lit, own, lx, y, lz, f, CORNER_OFF[f][k]);
    const ao = occ ? AOL[sh[0]] : 1;
    if (i < 2) a01 += ao; else a23 += ao;
    const lm = LUT ? rampAt(LUT, sh[1]) : 1;
    cols[i] = faceColor(_col4[i], FACE_SHADE[f] * ao * lm, emissive, tint);
  }
  stream.quad(p[0], p[1], p[2], p[3], uv, cols, !!occ && a01 < a23);
}

const WHITE = [1, 1, 1];
const TINT_CACHE = new Map();

/**
 * Placeholder biome tint. Vanilla ships grass/leaves/water sprites as grey masks and multiplies a
 * biome colour into them at draw time; with no biome grid yet this stands in for the average one,
 * close to the colormap means measured out of the vanilla jar. It is applied only where the sprite
 * really is a grey mask (`cell.g`): grass_block_side ships already brown and mod sprites are
 * authored in colour, so tinting on block name alone painted whole hillsides olive.
 */
function tintOf(state) {
  let t = TINT_CACHE.get(state.k);
  if (t) return t;
  // Match the block *name*, never the properties: almost every state in this world carries
  // `waterlogged=false`, so testing the whole key handed every waterlogged leaf, grass tuft and vine
  // on the map the blue water tint - which is why whole forests read as grey-blue at distance.
  const k = state.k.split('|')[0];
  if (/water/.test(k)) t = [0.3, 0.55, 0.85];
  else if (/grass|lily_pad|stem|vine|kelp|seagrass|duckweed|spore|shroomlight_moss|moss/.test(k)) t = [0.4, 0.78, 0.32];
  else if (/leaves|leaf|sapling|cactus|bamboo|sugar_cane|fern|bush|leafy|crop|fruit|podzol/.test(k)) t = [0.37, 0.64, 0.28];
  else t = WHITE;
  TINT_CACHE.set(state.k, t);
  return t;
}
export { tintOf };

function emitQuad(assets, streams, state, qi, bx, y, bz, chunk, at, lx, lz, stats, occ, AOL, lit, LUT, darkcut = -1, buried = null) {
  const gi = assets.ref[qi * 2];
  const pk = assets.ref[qi * 2 + 1];
  const texIdx = pk & 0xfff;
  const dir = ((pk >> 12) & 7) - 1;
  const cull = ((pk >> 15) & 7) - 1;
  const tintBit = (pk >> 19) & 1;
  const cell = assets.texCell(texIdx);
  if (!cell) { stats.skipped++; return false; }
  if (cell.kind === 3) stats.placeholder++;
  if (cull >= 0) {
    const v = FACE_INFO[cull].v;
    const nb = at(chunk.cx, chunk.cz, lx + v[0], y + v[1], lz + v[2]);
    if (nb === NEIGH_COVERED) { stats.covered++; return false; }
    if (nb >= 0 && assets.stateOpaque[nb] === 1) { stats.culled++; return false; }
  }
  if (darkcut >= 0 && lit) {
    // Same rule as the cube path: the air the quad faces decides visibility. A directionless quad
    // (cross-model plants, panes, interior faces) has no air side of its own, so the cell it stands
    // in is the only thing that can say whether anything could see it.
    const v = dir >= 0 ? FACE_INFO[dir].v : null;
    const air = v ? lit(lx + v[0], y + v[1], lz + v[2]) : lit(lx, y, lz);
    if (air >= 0 && air <= darkcut && (state.l ?? 0) <= darkcut) { stats.darkCulled++; return false; }
  }
  if (buried) {
    // The same "under the surface with no skylight" test as the cube path, against the same cell.
    const v2 = dir >= 0 ? FACE_INFO[dir].v : null;
    if (buried(lx + (v2 ? v2[0] : 0), y + (v2 ? v2[1] : 0), lz + (v2 ? v2[2] : 0))) { stats.buried++; return false; }
  }
  const tint = (tintBit || state.ti) && cell.g ? tintOf(state) : WHITE;
  const emissive = (state.l ?? 0) / 15 * 0.9;
  const shadeIdx = dir >= 0 ? FACE_SHADE[dir] : 0.85;
  const col = faceColor(_col, shadeIdx, emissive, tint);

  const po = gi * 12, uo = gi * 8;
  const P = assets.pos, U = assets.uv;
  const uv = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 4; i++) {
    p[i][0] = bx + P[po + i * 3] / assets.posScale;
    p[i][1] = y + P[po + i * 3 + 1] / assets.posScale;
    p[i][2] = bz + P[po + i * 3 + 2] / assets.posScale;
    const su = U[uo + i * 2] / 65535, sv = U[uo + i * 2 + 1] / 65535;
    uv[i][0] = cell.u0 + su * (cell.u1 - cell.u0);
    uv[i][1] = cell.v0 + sv * (cell.v1 - cell.v0);
  }
  // Authored geometry takes AO from which half of the block each vertex falls on: an
  // approximation, but the right one for slabs, stairs, panes and the rest of the quad path.
  let cols = col, flip = false;
  // A quad with no recorded direction (cross-model panes, interior faces) has no air side to sample,
  // so it takes the light of the block it stands in rather than a smooth average.
  const own = lit ? Math.max(0, lit(lx, y, lz)) : 15;
  if (dir >= 0 && cell.kind !== 2 && (occ || lit)) {
    const a = [0, 0, 0, 0];
    cols = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let lo = 0, hi = 0;
    for (let i = 0; i < 4; i++) {
      const off = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        if (k !== FACE_AXES[dir].nA) off[k] = qpx(assets, po, i, k) >= 0.5 ? 1 : -1;
      }
      const sh = cornerShade(occ, lit, own, lx, y, lz, dir, off);
      a[i] = (occ ? AOL[sh[0]] : 1) * (LUT ? rampAt(LUT, sh[1]) : 1);
      if (i < 2) lo += a[i]; else hi += a[i];
      cols[i] = faceColor(_c4[i], shadeIdx * a[i], emissive, tint);
    }
    flip = lo < hi;
  } else if (lit) {
    cols = faceColor(_col, shadeIdx * rampAt(LUT, own), emissive, tint);
  }
  streams[classify(cell.kind)].quad(p[0], p[1], p[2], p[3], uv, cols, flip);
  return true;
}

const _c4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

/** quantised vertex coordinate of geometry `po`, vertex i, axis k, in blocks 0..1 */
function qpx(assets, po, i, k) { return assets.pos[po + i * 3 + k] / assets.posScale; }
