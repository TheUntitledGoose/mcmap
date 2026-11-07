// Packed asset store: atlas table + the binary geometry blob.
//
// No DOM and no three.js in here on purpose: the same code runs under Node in the test
// suite, so a regression in the browser decode path shows up as a failing test rather
// than a black screen.
//
// geometry.bin layout (written by server/pack-assets.mjs):
//   header            32 bytes: 'DVGEO12 ' | u32 geoms | u32 quads | u32 posScale
//   positions         geoms * 12 int16, model units * posScale (one block = posScale)
//   sprite uvs        geoms * 8  uint16, 0..1 of the *source* texture, quantised to /65535
//   quad refs         quads * 2  uint32: [geometry index, packed flags]
// Sprite UVs are independent of the atlas layout; the atlas cell for a texture maps them
// into the page, which is what lets the atlas be repacked without touching geometry.

import { CANON_RING, decodeFaceCode, classifyStates } from '../../shared/cube-path.mjs';
import { collisionTable, stateFootprints, stateHeights, C_FULL } from '../../shared/player.mjs';

export const GEO_MAGIC = 'DVGEO12 ';

export class Assets {
  /**
   * @param {any} json     parsed atlas.json
   * @param {ArrayBuffer} geoBuf contents of geometry.bin
   */
  constructor(json, geoBuf) {
    this.json = json;
    this.size = json.atlasSize;
    this.textures = json.textures;
    this.states = json.states;
    this.posScale = json.geometry.posScale;

    const dv = new DataView(geoBuf);
    let magic = '';
    for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
    if (magic !== GEO_MAGIC) throw new Error(`bad geometry magic ${JSON.stringify(magic)}, expected ${JSON.stringify(GEO_MAGIC)}`);
    const geoms = dv.getUint32(8, true);
    const quads = dv.getUint32(12, true);
    const posScale = dv.getUint32(16, true);
    if (posScale !== this.posScale) throw new Error(`geometry posScale ${posScale} != atlas ${this.posScale}`);

    const POS = 32;
    const UV = POS + geoms * 24;
    const REF = UV + geoms * 16;
    if (geoBuf.byteLength < REF + quads * 8) {
      throw new Error(`geometry.bin is ${geoBuf.byteLength} bytes, needs ${REF + quads * 8}`);
    }
    this.geoms = geoms;
    this.quadCount = quads;
    this.pos = new Int16Array(geoBuf, POS, geoms * 12);
    this.uv = new Uint16Array(geoBuf, UV, geoms * 8);
    this.ref = new Uint32Array(geoBuf, REF, quads * 2);

    // state key -> state index (chunk palettes carry keys, the atlas is indexed)
    this.stateIndex = new Map();
    for (let i = 0; i < this.states.length; i++) this.stateIndex.set(this.states[i].k, i);

    // Per-state classification used for face culling and pass bucketing. Shared with worldd so
    // that "this state is a full cube" means one thing on both sides of the wire.
    const cls = classifyStates(this.states, this.textures);
    this.stateAir = cls.air;
    this.stateCube = cls.cube;
    this.stateOpaque = cls.opaque;
    this.stateFilm = cls.film;

    // What stops a walking body, and how far up inside its cell it reaches. The save stores no
    // collision boxes, so the heights come from the baked quads themselves: a half slab's geometry tops
    // out at 8 model units of 16 and is steppable, a cube's at 16 and is not. This table is the only
    // collision authority for the player physics - see shared/player.mjs.
    const unitsOfPos = this.posScale / 16;          // pos units per model unit (16 model units = 1 block)
    const geomsOf = (s) => {
      if (!s.g) return [];
      const out = [];
      for (const arm of s.g) for (const qi of arm) out.push(this.ref[qi * 2]);
      return out;
    };
    const maxYOf = (gi) => {
      const b = gi * 12;
      let m = 0;
      for (let k = 1; k < 12; k += 3) if (this.pos[b + k] > m) m = this.pos[b + k];
      return m / unitsOfPos;
    };
    // A quad lies flat when all four of its corners sit at one height. That single test separates
    // "has a top you can stand on" (cube, slab, fence post) from "is a plant" (crossed vertical quads),
    // without a per-mod list of which names are plants.
    const horizOf = (gi) => {
      const b = gi * 12;
      let lo = this.pos[b + 1], hi = lo;
      for (let k = 4; k < 12; k += 3) { const v = this.pos[b + k]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      return hi === lo;
    };
    this.stateHeight = stateHeights(this.states, geomsOf, maxYOf, 16);
    this.stateFoot = stateFootprints(this.states, geomsOf, horizOf);
    this.stateCollision = collisionTable(this.states, this.stateAir, this.stateFilm, this.stateHeight,
      this.stateFoot);
  }

  /** Collision byte for a 1-based global state id; 0 is "the table does not know this state". */
  collisionOf(id) { return id === 0 ? C_FULL : this.stateCollision[id - 1]; }

  /** State index for a chunk palette key; -1 when the state was never baked. */
  indexOf(key) { return this.stateIndex.get(key) ?? -1; }

  /**
   * Pick a weighted arm deterministically from a block position, so the same block
   * always renders the same variant and neighbouring chunks agree at their border.
   */
  pickArm(state, hash) {
    const arms = state.cube ?? state.g;
    if (arms.length === 1) return 0;
    const w = state.w;
    if (!w) return hash % arms.length;
    let total = 0;
    for (const x of w) total += x;
    let r = hash % total;
    for (let i = 0; i < arms.length; i++) {
      r -= w[i] ?? 1;
      if (r < 0) return i;
    }
    return arms.length - 1;
  }

  /** Atlas UV rect for one texture index, plus its pass class (0 opaque, 1 cutout, 2 translucent). */
  texCell(texIndex) {
    const t = this.textures[texIndex];
    return t ?? null;
  }
}

export { CANON_RING, decodeFaceCode };
