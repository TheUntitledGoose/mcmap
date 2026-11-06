// Browser reader for the worldd chunk payload (see server/chunk-payload.mjs for the writer).
// Mirrors openChunk() byte for byte; kept DOM-free so Node tests can run the real frames.
import {
  CHUNK_MAGIC, CHUNK_VERSION, FLAG_HEIGHT, FLAG_HEIGHT_MOTION, FLAG_BE, FLAG_CLASSIC, FLAG_LIGHT,
  LIGHT_VARIES, LIGHT_UNKNOWN, HEIGHT_BIAS, BATCH_MAGIC, SHELL_MAGIC, SHELL_VERSION, SHELL_HEADER, SHELL_COLS,
  SHELL_COLS_BYTES, SHELL_LIGHT_BYTES, SHELL_BAND_BYTES, SHELL_VERSION_MIN,
  OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_HEADER, OVERVIEW_CELL_BYTES, OVERVIEW_VERSION_MIN,
  overviewCellBytes,
} from '../../shared/chunk-format.mjs';

export {
  CHUNK_MAGIC, CHUNK_VERSION, FLAG_HEIGHT, FLAG_HEIGHT_MOTION, FLAG_BE, FLAG_CLASSIC, FLAG_LIGHT,
  LIGHT_VARIES, LIGHT_UNKNOWN, HEIGHT_BIAS, BATCH_MAGIC, SHELL_MAGIC, SHELL_VERSION, SHELL_HEADER, SHELL_COLS,
  SHELL_COLS_BYTES, SHELL_LIGHT_BYTES, SHELL_BAND_BYTES,
  OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_HEADER, OVERVIEW_CELL_BYTES,
};

const magicAt = (dv, at) => {
  let s = '';
  for (let i = 0; i < 8; i++) s += String.fromCharCode(dv.getUint8(at + i));
  return s;
};

/** FNV-1a over the frame, one u32 at a time (lengths are padded to 4 by the writer). */
export function frameDigest(u8) {
  let h = 0x811c9dc4;
  const n = u8.length >>> 2;
  const w = new Uint32Array(u8.buffer, u8.byteOffset, n);
  for (let i = 0; i < n; i++) {
    h ^= w[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;             // 0 is reserved for "no payload"
}

/**
 * Walk a batch container (see world-service packBatch): u32 frame count, then per frame a u32
 * length and the bytes padded to 4. Returns absolute [offset, length] pairs; a zero length means
 * "this chunk does not exist", which is information, not an error.
 */
function batchFrames(buf, wantMagic) {
  const dv = new DataView(buf, buf.byteOffset ?? 0, buf.byteLength);
  const magic = magicAt(dv, 0);
  if (magic !== wantMagic) throw new Error(`bad batch magic ${JSON.stringify(magic)}`);
  const count = dv.getUint32(8, true);
  const base = buf.byteOffset ?? 0;
  let p = base + 12;
  const frames = [];
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(p - base, true); p += 4;
    frames.push([p, len]);
    p += (len + 3) & ~3;
  }
  if (p !== base + buf.byteLength) throw new Error(`batch length drift ${p - base} != ${buf.byteLength}`);
  return frames;
}

/**
 * @param {ArrayBuffer} buf        a chunk frame, possibly a slice inside a batch container
 * @param {number} byteOffset      where the frame starts inside `buf`
 * @param {number} length          frame length; defaults to the rest of the buffer
 * Offsets below are frame-relative (`p`); typed-array views add `byteOffset`.
 */
export function openChunk(buf, byteOffset = 0, length = buf.byteLength - byteOffset) {
  if (length < 32) throw new Error(`chunk frame too short: ${length}`);
  const dv = new DataView(buf, byteOffset, length);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== CHUNK_MAGIC) throw new Error(`bad chunk magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(8, true);
  if (version !== CHUNK_VERSION) throw new Error(`chunk payload version ${version}, expected ${CHUNK_VERSION}`);
  const flags = dv.getUint16(10, true);
  const cx = dv.getInt32(12, true), cz = dv.getInt32(16, true), yMin = dv.getInt32(20, true);
  const yCount = dv.getUint16(24, true), paletteLen = dv.getUint16(26, true), unknownStates = dv.getUint32(28, true);

  let p = 32;
  const palette = new Uint16Array(buf, byteOffset + p, paletteLen); p += paletteLen * 2;
  p = (p + 3) & ~3;                                     // palette padding keeps views aligned
  const words = Math.ceil(yCount / 32);
  const mask = new Uint32Array(buf, byteOffset + p, words); p += words * 4;

  const sections = [], byY = new Map();
  for (let s = 0; s < yCount; s++) {
    if (!(mask[s >>> 5] & (1 << (s & 31)))) continue;
    const single = dv.getUint16(p, true); p += 2;
    let vox = null;
    if (!single) {
      if (((byteOffset + p) & 1) !== 0) throw new Error(`unaligned voxel array at ${p}`);
      vox = new Uint16Array(buf, byteOffset + p, 4096); p += 4096 * 2;
    }
    const sec = { y: yMin + s, single, vox };
    sections.push(sec); byY.set(sec.y, sec);
  }

  if (flags & FLAG_LIGHT) {
    for (const sec of sections) { sec.sky = dv.getUint8(p); p += 1; sec.blk = dv.getUint8(p); p += 1; }
    for (const sec of sections) {
      if (sec.sky === LIGHT_VARIES) { sec.skyArr = new Uint8Array(buf, byteOffset + p, 2048); p += 2048; }
      if (sec.blk === LIGHT_VARIES) { sec.blkArr = new Uint8Array(buf, byteOffset + p, 2048); p += 2048; }
    }
  }
  let height = null, heightMotion = null;
  if (flags & FLAG_HEIGHT) { height = new Uint16Array(buf, byteOffset + p, 256); p += 512; }
  if (flags & FLAG_HEIGHT_MOTION) { heightMotion = new Uint16Array(buf, byteOffset + p, 256); p += 512; }

  let blockEntities = null;
  if (flags & FLAG_BE) {
    const n = dv.getUint16(p, true); p += 2;
    const list = [];
    for (let i = 0; i < n; i++) {
      const x = dv.getInt32(p, true); p += 4;
      const y = dv.getInt32(p, true); p += 4;
      const z = dv.getInt32(p, true); p += 4;
      const id = dv.getUint8(p); p += 1;
      list.push({ x, y, z, id });
    }
    const tn = dv.getUint8(p); p += 1;
    const table = [];
    const dec = new TextDecoder('utf-8');
    for (let i = 0; i < tn; i++) {
      const l = dv.getUint8(p); p += 1;
      table.push(dec.decode(new Uint8Array(buf, byteOffset + p, l))); p += l;
    }
    blockEntities = { list, table };
  }
  if (p !== length) {
    throw new Error(`chunk frame length drift ${p} != ${length}`);
  }

  return {
    cx, cz, yMin, yCount, palette, sections, height, heightMotion, blockEntities, unknownStates,
    // A fingerprint of the bytes this chunk was read from. Two fetches of ground nobody edited give
    // the same number, which is what lets the viewer say "I already have the triangles for this" -
    // see web/js/mesh-key.js. Object identity cannot answer that: a refetch is a new object holding
    // the same world.
    digest: frameDigest(new Uint8Array(buf, (buf.byteOffset ?? 0) + byteOffset, length)),
    classicSections: !!(flags & FLAG_CLASSIC),
    /** the section covering a *world block* y, or null */
    sectionAt(y) { return byY.get(y >> 4) ?? null; },
    /** global state id at a block coordinate, or 0 outside the chunk */
    stateAt(x, y, z) {
      const s = byY.get(y >> 4);
      if (!s) return 0;
      return palette[s.single ? s.single - 1 : s.vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]];
    },
    /** highest visible block in a column (chunk-local x,z), or yMin*16 - 1 when empty */
    surfaceAt(x, z) { return (height ? height[((z & 15) << 4) | (x & 15)] : 0) - HEIGHT_BIAS; },
    /** [sky, block] light at a chunk-local block coordinate; flat sections cost nothing to read */
    lightAt(x, y, z) {
      const s = byY.get(y >> 4);
      if (!s) return [0, 0];
      if (s.sky !== LIGHT_VARIES && s.blk !== LIGHT_VARIES) return [s.sky ?? 0, s.blk ?? 0];
      const i = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
      const nib = (a) => { const b = a[i >> 1]; return (i & 1) ? (b >> 4) : (b & 15); };
      return [s.sky === LIGHT_VARIES ? nib(s.skyArr) : (s.sky ?? 0), s.blk === LIGHT_VARIES ? nib(s.blkArr) : (s.blk ?? 0)];
    },
  };
}

/**
 * Split a `/voxels` batch container into opened chunks. Frames are padded to 4 bytes by the
 * writer, so each frame can be read in place without copying.
 */
export function openBatch(buf) {
  const out = [];
  for (const [off, len] of batchFrames(buf, BATCH_MAGIC)) out.push(len ? openChunk(buf, off, len) : null);
  return out;
}

/**
 * A heightmap shell frame: 16-byte header, then four u16 planes of 256 columns indexed (z << 4) | x:
 *   height  WORLD_SURFACE top, biased by HEIGHT_BIAS - treetops, plants, the skin of a lake
 *   cover   the state sitting at that height (water, a flower, leaves) - 0 when nothing is there
 *   ground  biased top of the block the column gets *painted* with
 *   state   that paint state: the first solid, opaque block at or under the surface
 * and one light byte per column: the sky nibble and the block-light nibble falling on that
 * column's surface (shared/light.mjs packLight), so the far view shades with the save.
 * 2.25 KB per chunk, which still makes a far view over tens of thousands of chunks affordable next to
 * ~100 KB of full voxel payload.
 */
export function openShellFrame(buf, byteOffset = 0, length = buf.byteLength - byteOffset) {
  const dv = new DataView(buf, byteOffset, length);
  const magic = magicAt(dv, 0);
  if (magic !== SHELL_MAGIC) throw new Error(`bad shell magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(8, true);
  if (version < SHELL_VERSION_MIN || version > SHELL_VERSION) throw new Error(`shell frame version ${version}`);
  if (length < SHELL_HEADER + SHELL_COLS * SHELL_COLS_BYTES + SHELL_LIGHT_BYTES
      + (version >= 4 ? SHELL_BAND_BYTES : 0)) {
    throw new Error(`shell frame too short: ${length}`);
  }
  const cx = dv.getInt16(12, true), cz = dv.getInt16(14, true);
  const plane = (k) => new Uint16Array(buf, byteOffset + SHELL_HEADER + k * SHELL_COLS * 2, SHELL_COLS);
  const height = plane(0), cover = plane(1), ground = plane(2), state = plane(3);
  const light = new Uint8Array(buf, byteOffset + SHELL_HEADER + 4 * SHELL_COLS * 2, SHELL_COLS);
  // v3 frames stop at the light byte, and a far view mid-rebake should paint ground rather than throw:
  // no band plane means no skin anywhere, which is exactly what the mesher does with all-zero bands.
  const band = version >= 4
    ? new Uint8Array(buf, byteOffset + SHELL_HEADER + 4 * SHELL_COLS * 2 + SHELL_COLS, SHELL_COLS)
    : new Uint8Array(SHELL_COLS);
  return {
    cx, cz, height, cover, ground, state, light, band,
    // The frame's own bytes, where they live. A patch cut moved into a worker has to be handed these
    // frames, and shipping 324 parsed objects (six typed arrays and six closures each) costs more than
    // parsing them again would: the bytes travel, and the worker runs this same parser on them.
    buf, p: byteOffset, len: length,
    /** world Y of the top counted block in a column (chunk-local x,z) */
    surfaceAt(x, z) { return height[((z & 15) << 4) | (x & 15)] - HEIGHT_BIAS; },
    /** shell state id at a column, as a 1-based global state id (0 = nothing there) */
    stateAt(x, z) { return state[((z & 15) << 4) | (x & 15)]; },
    /** world Y of the top of the paint block - the terrain under a plant, canopy or lake */
    groundAt(x, z) { return ground[((z & 15) << 4) | (x & 15)] - HEIGHT_BIAS; },
    /** what actually sits at the surface height: water, a flower, leaves (0 = nothing) */
    coverAt(x, z) { return cover[((z & 15) << 4) | (x & 15)]; },
    /** packed light byte for a column: 0 in the far layer's own units means "read as zero" */
    lightAt(x, z) { return light[((z & 15) << 4) | (x & 15)]; },
    /** how many blocks of full-cube skin sit on top of this column's ground (0 = the ground itself) */
    bandAt(x, z) { return band[((z & 15) << 4) | (x & 15)]; },
  };
}

/** Split a `/shells` batch container into shell frames, `null` for chunks that do not exist. */
export function openShellBatch(buf) {
  const out = [];
  for (const [off, len] of batchFrames(buf, BATCH_MAGIC)) out.push(len ? openShellFrame(buf, off, len) : null);
  return out;
}

/**
 * The whole-dimension overview frame (server/shell-pack.mjs -> worldd /overview): one height and one
 * state per coarse cell, `cell` chunks on a side, for the entire loaded extent in a single request.
 * Heights are biased exactly as in a shell frame.
 */
export function openOverview(buf, byteOffset = 0, length = buf.byteLength - byteOffset) {
  const dv = new DataView(buf, byteOffset, length);
  if (length < OVERVIEW_HEADER) throw new Error(`overview frame too short: ${length}`);
  const magic = magicAt(dv, 0);
  if (magic !== OVERVIEW_MAGIC) throw new Error(`bad overview magic ${JSON.stringify(magic)}`);
  const version = dv.getUint16(8, true);
  if (version < OVERVIEW_VERSION_MIN || version > OVERVIEW_VERSION) throw new Error(`overview frame version ${version}`);
  const cell = dv.getUint16(10, true);
  const stamp = dv.getUint32(12, true);
  const x0 = dv.getInt32(16, true), z0 = dv.getInt32(20, true);
  const w = dv.getUint16(24, true), h = dv.getUint16(26, true);
  const n = w * h;
  const cellBytes = overviewCellBytes(version);
  if (length < OVERVIEW_HEADER + n * cellBytes) {
    throw new Error(`overview frame truncated: ${length} < ${OVERVIEW_HEADER + n * cellBytes}`);
  }
  const plane = (k) => new Uint16Array(buf, byteOffset + OVERVIEW_HEADER + k * n * 2, n);
  const height = plane(0), state = plane(1), ground = plane(2), cover = plane(3);
  const light = new Uint8Array(buf, byteOffset + OVERVIEW_HEADER + 4 * n * 2, n);
  const band = cellBytes >= 10
    ? new Uint8Array(buf, byteOffset + OVERVIEW_HEADER + 4 * n * 2 + n, n)
    : new Uint8Array(n);
  return {
    w, h, x0, z0, cell, stamp, height, state, ground, cover, light, band,
    /** world Y of the cell's surface (the 80th percentile of its chunk tops) */
    heightAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? -Infinity : height[j * w + i] - HEIGHT_BIAS; },
    /** world Y of the terrain the cell is painted with, i.e. under canopy, plants and water */
    groundAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? -Infinity : ground[j * w + i] - HEIGHT_BIAS; },
    /** 1-based global state id for the cell (0 = nothing baked) */
    stateAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? 0 : state[j * w + i]; },
    /** what sits at the surface height of that cell (water, plants, leaves) */
    coverAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? 0 : cover[j * w + i]; },
    /** packed sky|blk light byte of the column that speaks for the cell */
    lightAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? 0 : light[j * w + i]; },
    /** thickness of that cell's surface skin (0 = the ground itself) */
    bandAt(i, j) { return i < 0 || j < 0 || i >= w || j >= h ? 0 : band[j * w + i]; },
    /** chunk coordinate range one cell covers, for the skin/overview handover test */
    cellChunks(i, j) { return [x0 + i * cell, z0 + j * cell, x0 + (i + 1) * cell - 1, z0 + (j + 1) * cell - 1]; },
  };
}
