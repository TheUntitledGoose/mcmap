// Chunk payload wire constants — the single definition shared by the worldd writer
// (server/chunk-payload.mjs) and the browser reader (web/js/payload.js). If the two ever
// disagree, tests/chunk-payload.test.mjs and tests/web-mesh.test.mjs both break loudly.

export const CHUNK_MAGIC = 'DVDX1   ';
export const CHUNK_VERSION = 3;   // v3 carries per-section light (see FLAG_LIGHT)

export const FLAG_HEIGHT = 1;         // WORLD_SURFACE present
export const FLAG_HEIGHT_MOTION = 2;  // MOTION_BLOCKING present
export const FLAG_BE = 4;
export const FLAG_CLASSIC = 8;        // some sections used the padded (pre-1.16.220) long layout
export const FLAG_LIGHT = 16;         // per-section sky/block light follows the section block

// Per section, per light kind, one code byte:
//   0..15  every voxel in the section has that light level (Starlight writes marker 1 for uniform
//          zero, and we resolve "no array, no marker" from the heightmap + dimension)
//   16     the level varies: a 2048-byte nibble array (index i -> byte i>>1, low nibble if i even)
//   17     unknown — only emitted when the chunk has no heightmap to reason from; treat as 0
export const LIGHT_VARIES = 16;
export const LIGHT_UNKNOWN = 17;

export const HEIGHT_BIAS = 2048;      // heightmaps travel as unsigned (worldY + bias)

export const BATCH_MAGIC = 'DVDXB2  ';      // v2: the container names the state table its ids use
export const BATCH_MAGIC_V1 = 'DVDXB1  ';    // the same container, before it could name one
export const BATCH_HEADER = 16;                  // magic + table hash u32 + frame count u32
export const BATCH_HEADER_V1 = 12;               // magic + frame count u32

/**
 * FNV-1a over a state table's keys, in table order: the number a payload names its ids by.
 *
 * A chunk payload is a list of global state ids, and those ids mean something only next to the atlas
 * that numbered them. Two saves on one box measure that literally: in one save's table
 * `minecraft:dirt` is id 6 and `minecraft:stone` is 4; in the other, dirt is 14 and stone is still 4.
 * So an answer that came from the wrong save is not noise - it is a plausible wrong world, drawn with
 * the right textures. The container therefore says which table it numbered against, and the page
 * refuses an answer numbered by a table it does not hold.
 */
export function stateTableHash(keys) {
  let h = 0x811c9dc5;
  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i]);
    for (let j = 0; j < key.length; j++) { h = (h ^ key.charCodeAt(j)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
    h = (h ^ 0x1f) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;              // separator: "a"+"b" != "ab"
    h = (h ^ (i & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;        // and the id, so order counts
    h = (h ^ ((i >>> 8) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ keys.length) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  return (h >>> 0) || 1;                 // 0 means "this container names no table", so a hash may not be 0
}

// Heightmap shell (M5): one 16x16 grid of column tops per chunk, no section data. It exists so the
// browser can hold a few thousand chunks of *silhouette* for the far view at ~1 KB each instead of
// ~100 KB each, which is the difference between seeing 100 blocks of the world and seeing all of it.
export const SHELL_MAGIC = 'DVDXSHL1';
export const SHELL_VERSION = 5;   // v5: the band byte stops at films (v4 counted a lake's water as "skin")
// Older frames are still readable: v3 has no band plane at all and v4 measured skin through water, and in
// both cases the far view paints ground with no extra geometry rather than misreading heights. Shell
// *packs* carry this version in their policy, so a pack baked at v4 is refused until it is rebaked.
// Older frames are still readable, they simply have no band plane, so a half-finished re-bake does not
// blank the far view: the reader takes what the frame carries.
export const SHELL_VERSION_MIN = 3;
export const SHELL_HEADER = 16;
export const SHELL_COLS = 256;      // 16x16 columns, indexed (z << 4) | x like a heightmap
// Per column, four u16 arrays (struct of arrays, so deflate has something to bite on):
//   surface  WORLD_SURFACE height + HEIGHT_BIAS - the silhouette, canopy and plants included
//   cover    the state actually sitting at that height (water, a flower, leaves, ...)
//   ground   height + HEIGHT_BIAS of the top of the block the column is *painted* with
//   state    that paint state: the first solid, opaque block at or under the surface
export const SHELL_COLS_BYTES = 8;
// One byte per column: the sky nibble and the block-light nibble that fall on that column's
// surface (shared/light.mjs packLight). 256 B per chunk against 2 KB of columns: the far layer
// pays a twelfth more to stop being a flat-bright map while the detail layer shades itself.
export const SHELL_LIGHT_BYTES = SHELL_COLS;
// One more byte per column, and the reason it exists: `height` and `ground` say where a column starts
// and where it stands, but not how thick the skin on top of it is. Without that, a coarse cell has to
// answer "how tall is this?" with one number, so a canopy becomes a column standing on the forest floor
// - a tree drawn as a tower. `band` is the thickness of the run of full cubes that starts at the surface
// block: canopy 5 means leaves from height-4 to height; 0 means the surface is not a full cube (a plant,
// a pane) and 255 means the solid goes deeper than we thought worth looking, i.e. ordinary ground.
export const SHELL_BAND_BYTES = SHELL_COLS;

// geometry.bin
export const GEO_MAGIC = 'DVGEO12 ';

// Whole-dimension heightmap overview: one frame, decimated columns, no batch container.
// Header: magic(8) version(2) cell(2) atlasStamp(4) x0 i32 z0 i32 w u16 h u16, then four u16
// arrays of w*h: surface heights, paint states, ground heights, cover states - same four per cell as
// a shell frame has per column (see SHELL_COLS_BYTES) - then a light byte and a surface-band byte.
// `cell` is in chunks: cell (i,j) covers chunks x0+i*cell, ...
export const OVERVIEW_MAGIC = 'DVSHOV4 ';
export const OVERVIEW_VERSION = 6;   // v6: follows the v5 shell band, which stops at films
export const OVERVIEW_VERSION_MIN = 5;
export const OVERVIEW_HEADER = 28;
// bytes per cell in an overview file: four u16 planes plus a light byte, plus a surface-band byte from v5
export const OVERVIEW_CELL_BYTES = 10;
export const overviewCellBytes = (version) => (version >= 5 ? 10 : 9);
