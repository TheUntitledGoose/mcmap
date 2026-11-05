// Baked coarse LOD tiles: the whole world as pre-made vertex streams, so the far view costs a file
// read instead of meshing.
//
// One tile is one region (32x32 chunks, the same granularity as the shell packs) meshed at a fixed
// coarse cell, 16 blocks per column - one column per chunk, i.e. exactly the resolution the
// whole-dimension overview used to have. That is the floor of the LOD ladder: nothing in the world is
// drawn coarser than this, and nothing finer than this is baked (see PLAN.md: cell 4 for the whole
// overworld would be 70 M verts and cell 1 is 770 M, which no GPU can look at).
//
// Why baking is affordable: at 16 blocks per column the overworld is ~28 verts per chunk, 8 M verts
// for all 284 239 chunks, ~130 MB of raw vertices before deflate (a region tile is ~450 KB raw,
// ~100 KB on disk). The voxel detail tier for the same world would be 9.3 G verts (~220 GB). The voxel detail tier for the same
// world would be 9.3 G verts (~220 GB) - that is the tier that must stay live.
//
// A tile carries the far-paint policy it was baked with (ground/cover rule, water film alpha, AO
// match, light curve). The browser compares that against its own settings and refuses to draw a tile
// it would disagree with, rather than quietly showing a different world.
//
// Layout, all little-endian, no compression in this image (the on-disk file deflates it; worldd
// inflates before serving, so the browser needs no decompressor):
//
//   0  magic 'DVDXLOD1'
//   8  u16 version              10 u16 cell (blocks per column)
//   12 u32 atlas+policy stamp   16 i16 region x     18 i16 region z
//   20 u32 vertex count         24 u32 body length
//   28 u8  groundFar            29 u8  waterOpacity*100
//   30 u8  darkFloor*100       31 u8  darkGamma*100
//   32 u8  skyScale*100        33 u8  lightOn
//   34 u16 aoFar*1000          36 u32 reserved (0)
//   40 body: pos f32*3 (verts*12 bytes), then col u8*4 (verts*4 bytes) - block layout, exactly the
//      two attribute arrays three wants, so the browser can view them over the buffer without a copy
//
// No UVs: a baked tile is a flat paint (the far view's default). The textured far mode is opt-in and
// live-meshed, so a tile would only be able to draw itself flat anyway; storing UVs would cost 22%
// of the file for a mode that cannot use them. Version 2 if that ever changes.
export const LOD_MAGIC = 'DVDXLOD1';
export const LOD_VERSION = 1;
export const LOD_HEADER = 40;
export const LOD_CELL = 16;            // blocks per column
export const LOD_TILE_CHUNKS = 32;     // chunks per tile side (a region)
export const LOD_BYTES_PER_VERT = 16;  // f32 xyz + u8 rgba, block layout
export const LOD_TILE_BYTES = LOD_HEADER + LOD_TILE_CHUNKS * LOD_TILE_CHUNKS * 28 * LOD_BYTES_PER_VERT;

/** The far-paint policy a tile was baked with, in the units the header stores. */
export function policyBits(p) {
  return {
    groundFar: p.groundFar ? 1 : 0,
    water: Math.round(Math.min(1, Math.max(0, +p.waterOpacity ?? 0)) * 100),
    darkFloor: Math.round(Math.min(1, Math.max(0, +p.darkFloor ?? 0)) * 100),
    darkGamma: Math.round(Math.min(2, Math.max(0, +p.darkGamma ?? 0)) * 100),
    skyScale: Math.round(Math.min(1, Math.max(0, +p.skyScale ?? 0)) * 100),
    lightOn: p.lightOn === false ? 0 : 1,
    aoFar: Math.round(Math.min(4, Math.max(0, +p.aoFar ?? 1)) * 1000),
  };
}

/**
 * Encode a meshed tile. `pos`/`col` are exactly what the browser mesher's VertexStream produced
 * (Float32Array world positions, Uint8Array normalized colors); the uv stream is dropped.
 */
export function encodeLodTile({ rx, rz, stamp, cell = LOD_CELL, pos, col, count, policy }) {
  if (count === undefined) count = pos.length / 3;
  const p = policyBits(policy ?? {});
  const head = new DataView(new ArrayBuffer(LOD_HEADER));
  const u8 = new Uint8Array(head.buffer);
  for (let i = 0; i < LOD_MAGIC.length; i++) u8[i] = LOD_MAGIC.charCodeAt(i);
  head.setUint16(8, LOD_VERSION, true);
  head.setUint16(10, cell, true);
  head.setUint32(12, stamp >>> 0, true);
  head.setInt16(16, rx, true);
  head.setInt16(18, rz, true);
  head.setUint32(20, count, true);
  head.setUint32(24, count * LOD_BYTES_PER_VERT, true);
  head.setUint8(28, p.groundFar);
  head.setUint8(29, p.water);
  head.setUint8(30, p.darkFloor);
  head.setUint8(31, p.darkGamma);
  head.setUint8(32, p.skyScale);
  head.setUint8(33, p.lightOn);
  head.setUint16(34, p.aoFar, true);
  const body = new Uint8Array(count * LOD_BYTES_PER_VERT);
  body.set(new Uint8Array(pos.buffer, pos.byteOffset, count * 12), 0);
  body.set(new Uint8Array(col.buffer, col.byteOffset, count * 4), count * 12);
  const out = new Uint8Array(LOD_HEADER + body.length);
  out.set(u8, 0);
  out.set(body, LOD_HEADER);
  return out;
}

/**
 * Read a tile image. Rejects anything the current build cannot use rather than mis-drawing it:
 * magic, version, cell, vertex count against length, and (when given) the atlas stamp.
 *
 * @returns {{rx,rz,stamp,cell,verts,policy,pos:Float32Array,col:Uint8Array}|null}
 */
export function openLodTile(buf, off = 0, len = buf.byteLength - off, wantStamp = null) {
  const u8 = new Uint8Array(buf, off, len);
  const dv = new DataView(buf, off, len);
  const magic = String.fromCharCode(...u8.subarray(0, 8));
  if (magic !== LOD_MAGIC) throw new Error(`lod tile bad magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(8, true);
  if (version !== LOD_VERSION) throw new Error(`lod tile version ${version} != ${LOD_VERSION}`);
  const cell = dv.getUint16(10, true);
  const stamp = dv.getUint32(12, true);
  if (wantStamp !== null && stamp !== (wantStamp >>> 0)) {
    throw new Error(`lod tile stamp ${stamp.toString(16)} != ${wantStamp.toString(16)}`);
  }
  const verts = dv.getUint32(20, true);
  const bodyLen = dv.getUint32(24, true);
  if (len < LOD_HEADER + bodyLen) throw new Error(`lod tile truncated: ${len} < ${LOD_HEADER + bodyLen}`);
  if (bodyLen !== verts * LOD_BYTES_PER_VERT) {
    throw new Error(`lod tile body ${bodyLen} != ${verts} verts`);
  }
  if (cell !== LOD_CELL) throw new Error(`lod tile cell ${cell} != ${LOD_CELL}`);
  // The body is pos block then col block, each contiguous, so both views can alias the buffer
  // directly - no copy - as long as each start is 4-byte aligned. LOD_HEADER (40) and the pos block
  // (verts*12) are both multiples of 4.
  const pos = new Float32Array(buf, off + LOD_HEADER, verts * 3);
  const col = new Uint8Array(buf, off + LOD_HEADER + verts * 12, verts * 4);
  return {
    rx: dv.getInt16(16, true), rz: dv.getInt16(18, true), stamp, cell, verts, pos, col,
    policy: {
      groundFar: dv.getUint8(28),
      waterOpacity: dv.getUint8(29) / 100,
      darkFloor: dv.getUint8(30) / 100,
      darkGamma: dv.getUint8(31) / 100,
      skyScale: dv.getUint8(32) / 100,
      lightOn: dv.getUint8(33),
      aoFar: dv.getUint16(34, true) / 1000,
    },
  };
}

/**
 * Which fields describe the *shape* of the ground, and which only describe how it was shaded.
 *
 * That split decides what a disagreement costs. A tile baked under another ground rule stands where
 * the live view would put a different surface, so it must not be drawn at all. A tile baked under
 * another light curve or AO floor is the same terrain with slightly different vertex colours - and
 * throwing the whole world's worth of pre-made geometry away because a slider moved is what leaves
 * the distance unpainted. So shade differences are reported and drawn through.
 */
export const LOD_SHADE_FIELDS = ['water', 'darkFloor', 'darkGamma', 'skyScale', 'lightOn', 'aoFar'];

/**
 * Disagreement between a tile and the viewer's far paint, with the class of it.
 *
 * @returns {{field: string, kind: 'geom'|'shade'}|null}
 */
export function policyMismatch(tile, want) {
  const a = policyBits(tile.policy), b = policyBits(want);
  for (const k in a) {
    if (a[k] === b[k]) continue;
    return { field: k, kind: LOD_SHADE_FIELDS.includes(k) ? 'shade' : 'geom' };
  }
  return null;
}

/**
 * Does this tile agree with the far paint the viewer is set to? A tile baked with a different ground
 * rule is a different world, so it is refused rather than drawn.
 */
export function policyMatches(tile, want) {
  const a = policyBits(tile.policy), b = policyBits(want);
  for (const k in a) if (a[k] !== b[k]) return k;
  return null;
}
