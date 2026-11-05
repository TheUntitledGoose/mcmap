// Chunk decode + compact voxel payload for the renderer.
//
// The payload is the wire contract between worldd and the browser: one frame per chunk holding the
// voxels as 16-bit atlas state ids plus a small palette, so the browser can build geometry *and*
// still do x-ray/filter/highlight work later (it has the voxel data, not just triangles).
import { stateKey } from '../shared/state-key.mjs';
import {
  CHUNK_MAGIC, CHUNK_VERSION, FLAG_HEIGHT, FLAG_HEIGHT_MOTION, FLAG_BE, FLAG_CLASSIC, FLAG_LIGHT,
  LIGHT_VARIES, LIGHT_UNKNOWN,
  HEIGHT_BIAS,
} from '../shared/chunk-format.mjs';

export { CHUNK_MAGIC, CHUNK_VERSION, FLAG_HEIGHT, FLAG_HEIGHT_MOTION, FLAG_BE, FLAG_CLASSIC,
  FLAG_LIGHT, LIGHT_VARIES, LIGHT_UNKNOWN, HEIGHT_BIAS };

/** The light level when a nibble array is completely flat, or null when it varies. */
export function uniformLight(arr) {
  if (!arr || !arr.length) return null;
  const b0 = arr[0] & 0xff;
  if ((b0 & 15) !== (b0 >> 4)) return null;
  for (let i = 1; i < arr.length; i++) if ((arr[i] & 0xff) !== b0) return null;
  return b0 & 15;
}

// ---- packed long-array reading -------------------------------------------------------------
// Two layouts exist in the wild: modern entries pack back to back and may straddle a long boundary,
// pre-1.16.220 entries are padded so they never do. `unpackFast` is the production reader and
// `unpackBigInt` is the dumb obvious one the tests use as an oracle.

export function bitsFor(paletteLength, classic = false) {
  if (paletteLength <= 1) return classic ? 4 : 0;
  return Math.max(4, 32 - Math.clz32(paletteLength - 1));
}

/**
 * Which packing a section's long array uses. The array length proves nothing (some writers here
 * allocate more longs than the packing needs), so look at the content instead: in the padded layout
 * each long holds floor(64/bits) entries and the leftover high bits of *every* long stay zero. If
 * any long has bits set up there, an entry crossed the boundary and it is the modern layout.
 */
export function looksClassic(longs, bits) {
  const used = Math.floor(64 / bits) * bits;
  if (used >= 64) return false;                     // identical either way for this width
  const words = toWords(longs);
  for (let i = 0; i < longs.length; i++) {
    const lo = words[2 * i], hi = words[2 * i + 1];
    if (used <= 32) { if ((lo >>> used) !== 0 || hi !== 0) return false; }
    else if ((hi >>> (used - 32)) !== 0) return false;
  }
  return true;
}

/** Normalise a list of BigInt / number / BigInt64Array values to signed 32-bit word pairs. */
function toWords(longs) {
  const n = longs.length;
  const w = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = longs[i];
    if (typeof v === 'bigint') { w[2 * i] = Number(v & 0xffffffffn); w[2 * i + 1] = Number((v >> 32n) & 0xffffffffn); }
    else { w[2 * i] = v | 0; w[2 * i + 1] = 0; }    // numbers from our NBT reader are already int32 pairs
  }
  return w;
}

/** Modern layout: entries packed back to back, crossing long boundaries freely. */
export function unpackFast(longs, bits, count, out) {
  out = out ?? new Uint16Array(count);
  if (bits === 0) { out.fill(0); return out; }
  const words = toWords(longs);
  const mask = (1 << bits) - 1;
  for (let i = 0; i < count; i++) {
    const bit = i * bits;
    const w = bit >>> 5, off = bit & 31;
    let v = (words[w] >>> off) & mask;
    if (off && off + bits > 32) v |= (words[w + 1] << (32 - off)) & mask;
    out[i] = v;
  }
  return out;
}

/** Pre-1.16.220 layout: floor(64/bits) entries per long, remainder of the long unused. */
export function unpackClassic(longs, bits, count, out) {
  out = out ?? new Uint16Array(count);
  if (bits === 0) { out.fill(0); return out; }
  const per = Math.floor(64 / bits);
  const words = toWords(longs);
  const mask = (1 << bits) - 1;
  for (let i = 0; i < count; i++) {
    const bit = Math.floor(i / per) * 64 + (i % per) * bits;
    const w = bit >>> 5, off = bit & 31;
    let v = (words[w] >>> off) & mask;
    if (off && off + bits > 32) v |= (words[w + 1] << (32 - off)) & mask;
    out[i] = v;
  }
  return out;
}

export function unpackBigInt(longs, bits, count, classic = false) {
  const out = new Uint16Array(count);
  if (bits === 0) return out;
  const B = BigInt(bits), M = (1n << B) - 1n;
  const per = classic ? BigInt(Math.floor(64 / bits)) : 0n;
  for (let i = 0; i < count; i++) {
    const bit = classic ? (BigInt(i) / per) * 64n + (BigInt(i) % per) * B : BigInt(i) * B;
    const li = Number(bit / 64n), off = Number(bit % 64n);
    let v = BigInt(longs[li] ?? 0n) >> BigInt(off);
    if (off + bits > 64) v |= BigInt(longs[li + 1] ?? 0n) << BigInt(64 - off);
    out[i] = Number(v & M);
  }
  return out;
}

// ---- heightmaps ----------------------------------------------------------------------------

/** Vanilla packs heightmaps with just enough bits for the world height, e.g. 384 -> 9 bits. */
export function heightBits(spanBlocks) { return Math.max(1, 32 - Math.clz32(spanBlocks)); }

/**
 * Read one stored heightmap. Values count up from the world's minimum y and hold one *above* the
 * highest counted block, so shift to absolute world y and step back down: the payload carries
 * "highest block that counts", or (minY - 1) for an empty column.
 *
 * WORLD_SURFACE counts every block the game treats as non-air (what the renderer wants for its
 * shell pass). MOTION_BLOCKING follows the game's "blocks motion" predicate, which in this world
 * ignores some modded leaves - useful for approximating sky light, but not a picture of what is
 * actually visible from above.
 */
function unpackStoredHeightmap(longs, yMin, yCount, nbt) {
  if (!longs?.length) return null;
  const span = yCount * 16;
  const bits = heightBits(span);
  const tight = Math.ceil(256 * bits / 64);
  const padded = Math.ceil(256 / Math.floor(64 / bits));
  const classic = longs.length !== tight && longs.length >= padded;
  const arr = longs.map((v) => typeof v === 'bigint' ? v : BigInt(v));
  const v = classic ? unpackClassic(arr, bits, 256) : unpackFast(arr, bits, 256);
  if (v.some((x) => x > span)) return null;         // wrong width: values cannot exceed the world
  const minY = (nbt.yPos !== undefined ? Number(nbt.yPos) : yMin) * 16;
  const h = new Uint16Array(256);
  for (let i = 0; i < 256; i++) h[i] = Math.max(0, Math.min(65535, v[i] + HEIGHT_BIAS + minY - 1));
  return h;
}

// ---- state table ----------------------------------------------------------------------------

/**
 * state ids: Map<state key, id>; ids are 1-based so 0 can mean "the census did not know this state",
 * in which case the renderer draws the placeholder cube instead of dropping the voxel.
 */
export function buildStateIds(keys) {
  const m = new Map();
  let i = 1;
  for (const k of keys) m.set(k, i++);
  return m;
}

// ---- decode: chunk NBT -> payload fields ----------------------------------------------------

export function decodeChunk(nbt, stateIds, opts = {}) {
  if (!nbt?.sections) return null;
  const cx = Number(nbt.xPos), cz = Number(nbt.zPos);
  const sections = (nbt.sections ?? []).map(s => ({
    y: Number(s.Y),
    pal: s.block_states?.palette ?? s.BlockStatePalette ?? null,
    data: s.block_states?.data ?? s.BlockStates ?? null,
    classic: !s.block_states && !!s.BlockStatePalette,
    // Light rides with the section: vanilla nibble arrays where it varies, and Starlight's marker
    // (1 = uniform zero, so the array was skipped) where it did not need one.
    skyArr: s.SkyLight ?? null, blkArr: s.BlockLight ?? null,
    mkS: s['starlight.skylight_state'], mkB: s['starlight.blocklight_state'],
  })).filter(s => s.pal && s.pal.length);
  if (!sections.length) return null;
  sections.sort((a, b) => a.y - b.y);
  const yMin = sections[0].y;
  const yCount = sections[sections.length - 1].y - yMin + 1;

  // Chunk palette: global state ids, deduped. Voxels index this, so a voxel is 2 bytes no matter how
  // many distinct states the world has, and identical sections across the chunk share entries.
  const palIds = [0];                               // slot 0 is always "unknown / air-like"
  const palIndexOf = new Map([[0, 0]]);
  let unknown = 0, badIndices = 0;
  const paletteOf = (pal) => {
    const out = new Uint16Array(pal.length);
    for (let i = 0; i < pal.length; i++) {
      let id = stateIds.get(stateKey(pal[i].Name, pal[i].Properties));
      if (id === undefined) { id = 0; unknown++; }
      let at = palIndexOf.get(id);
      if (at === undefined) { at = palIds.length; palIndexOf.set(id, at); palIds.push(id); }
      out[i] = at;
    }
    return out;
  };

  const out = {
    version: CHUNK_VERSION,
    cx, cz, yMin, yCount,
    palette: null,                                  // filled after the section pass
    sections: [],
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, badPaletteIndices: 0,
    classicSections: 0,
  };

  for (const s of sections) {
    const local = paletteOf(s.pal);
    const bits = bitsFor(s.pal.length, s.classic);
    let vox = null, single = 0;
    if (bits === 0 || s.pal.length === 1) {
      single = local[0] + 1;
    } else {
      const raw = s.data ?? [];
      vox = new Uint16Array(4096);
      const classic = s.classic || looksClassic(raw, bits);
      if (classic) { unpackClassic(raw, bits, 4096, vox); out.classicSections = 1; }
      else unpackFast(raw, bits, 4096, vox);
      for (let i = 0; i < 4096; i++) {
        const at = vox[i];
        // an index past the end of the palette means the layout guess was wrong or the chunk is
        // corrupt; keep air rather than letting the mesher read a random state
        vox[i] = at < local.length ? local[at] : (badIndices++, 0);
      }
    }
    out.sections.push({ y: s.y, single, vox, skyArr: s.skyArr, blkArr: s.blkArr, mkS: s.mkS, mkB: s.mkB });
  }

  out.palette = new Uint16Array(palIds);
  out.unknownStates = unknown;                      // counters settle only after the section pass
  out.badPaletteIndices = badIndices;

  const hmaps = nbt.Heightmaps;
  if (hmaps) {
    out.height = unpackStoredHeightmap(hmaps.WORLD_SURFACE, yMin, yCount, nbt);
    out.heightMotion = unpackStoredHeightmap(hmaps.MOTION_BLOCKING, yMin, yCount, nbt);
  }

  // ---- light (M6). Resolve every section down to either a flat level or a real array, so the
  // browser never has to know about Starlight's markers or what an absent array meant. Sections with
  // neither an array nor a marker are open sky above the terrain or cave air below it: the heightmap
  // decides, and the dimension decides whether sky exists at all (the nether writes no skylight data
  // whatsoever - measured in PLAN 8.2).
  if (opts.light !== false) {
    const hasSky = opts.dimHasSky !== false;
    let skyLimit = null;
    if (out.height) {
      skyLimit = -1e9;
      for (const v of out.height) { const w = v - HEIGHT_BIAS; if (w > skyLimit) skyLimit = w; }
    }
    for (const s of out.sections) {
      const code = (kind) => {
        const arr = kind === 'sky' ? s.skyArr : s.blkArr;
        const mk = kind === 'sky' ? s.mkS : s.mkB;
        if (arr && arr.length) {
          const u = uniformLight(arr);
          if (u !== null) return u;
          if (kind === 'sky') s.skyBytes = arr; else s.blkBytes = arr;
          return LIGHT_VARIES;
        }
        if (mk === 1 || mk === 2) return 0;             // Starlight says this section is unlit
        if (kind !== 'sky' || !hasSky) return 0;
        if (skyLimit === null) return LIGHT_UNKNOWN;    // no heightmap to reason from
        return s.y * 16 > skyLimit ? 15 : 0;            // open sky above the build-up, dark below
      };
      s.sky = code('sky'); s.blk = code('blk');
      delete s.skyArr; delete s.blkArr; delete s.mkS; delete s.mkB;
    }
  }

  const bes = nbt.block_entities;
  if (bes?.length) {
    const table = [], at = new Map(), list = [];
    for (const be of bes) {
      const id = String(be.id ?? '');
      let ti = at.get(id);
      if (ti === undefined) { ti = table.length; at.set(id, ti); table.push(id); }
      list.push({ x: Number(be.x), y: Number(be.y), z: Number(be.z), id: ti });
    }
    out.blockEntities = { list, table };
  }
  return out;
}

// ---- wire format ----------------------------------------------------------------------------

export function packChunk(c) {
  const words = Math.ceil(c.yCount / 32);
  const hasH = !!c.height, hasHM = !!c.heightMotion, hasBE = !!c.blockEntities?.list.length;
  let beBytes = 0;
  if (hasBE) {
    beBytes = 2 + c.blockEntities.list.length * 13 + 1 +
      c.blockEntities.table.reduce((n, s) => n + 1 + Buffer.byteLength(s), 0);
  }
  const palEnd = 32 + c.palette.length * 2;
  const palPad = (4 - (palEnd & 3)) & 3;            // keep the mask and voxel views aligned
  const hasL = c.sections.some((s) => s.sky !== undefined || s.blk !== undefined);
  const lightBytes = hasL
    ? c.sections.length * 2
      + c.sections.reduce((n, s) => n + (s.sky === LIGHT_VARIES ? 2048 : 0) + (s.blk === LIGHT_VARIES ? 2048 : 0), 0)
    : 0;
  const size = palEnd + palPad + words * 4
    + c.sections.reduce((n, s) => n + 2 + (s.vox ? 4096 * 2 : 0), 0)
    + lightBytes
    + (hasH ? 512 : 0) + (hasHM ? 512 : 0) + beBytes;

  const buf = Buffer.allocUnsafe(size);
  let p = 0;
  buf.write(CHUNK_MAGIC, p, 'ascii'); p += 8;
  buf.writeUInt16LE(c.version ?? CHUNK_VERSION, p); p += 2;
  buf.writeUInt16LE((hasH ? FLAG_HEIGHT : 0) | (hasHM ? FLAG_HEIGHT_MOTION : 0)
    | (hasBE ? FLAG_BE : 0) | (c.classicSections ? FLAG_CLASSIC : 0) | (hasL ? FLAG_LIGHT : 0), p); p += 2;
  buf.writeInt32LE(c.cx, p); p += 4;
  buf.writeInt32LE(c.cz, p); p += 4;
  buf.writeInt32LE(c.yMin, p); p += 4;
  buf.writeUInt16LE(c.yCount, p); p += 2;
  buf.writeUInt16LE(c.palette.length, p); p += 2;
  buf.writeUInt32LE(c.unknownStates ?? 0, p); p += 4;

  for (const id of c.palette) { buf.writeUInt16LE(id, p); p += 2; }
  p += palPad;
  const mask = new Uint32Array(words);
  for (const s of c.sections) mask[(s.y - c.yMin) >>> 5] |= 1 << ((s.y - c.yMin) & 31);
  for (const w of mask) { buf.writeUInt32LE(w, p); p += 4; }
  for (const s of c.sections) {
    buf.writeUInt16LE(s.single, p); p += 2;
    if (!s.vox) continue;
    for (let i = 0; i < 4096; i++) { buf.writeUInt16LE(s.vox[i], p); p += 2; }
  }
  // Light lives after the section block so the voxel views stay aligned: two code bytes per
  // present section, then the varying nibble arrays in the same order.
  if (hasL) {
    for (const s of c.sections) { buf.writeUInt8(s.sky ?? LIGHT_UNKNOWN, p); p += 1; buf.writeUInt8(s.blk ?? LIGHT_UNKNOWN, p); p += 1; }
    for (const s of c.sections) {
      if (s.sky === LIGHT_VARIES) for (let i = 0; i < 2048; i++) buf[p++] = s.skyBytes[i] & 0xff;
      if (s.blk === LIGHT_VARIES) for (let i = 0; i < 2048; i++) buf[p++] = s.blkBytes[i] & 0xff;
    }
  }
  if (hasH) for (let i = 0; i < 256; i++) { buf.writeUInt16LE(c.height[i], p); p += 2; }
  if (hasHM) for (let i = 0; i < 256; i++) { buf.writeUInt16LE(c.heightMotion[i], p); p += 2; }
  if (hasBE) {
    buf.writeUInt16LE(c.blockEntities.list.length, p); p += 2;
    for (const be of c.blockEntities.list) {
      buf.writeInt32LE(be.x, p); p += 4; buf.writeInt32LE(be.y, p); p += 4; buf.writeInt32LE(be.z, p); p += 4;
      buf.writeUInt8(be.id, p); p += 1;
    }
    buf.writeUInt8(c.blockEntities.table.length, p); p += 1;
    for (const s of c.blockEntities.table) {
      const b = Buffer.from(s, 'utf8');
      buf.writeUInt8(b.length, p); p += 1;
      b.copy(buf, p); p += b.length;
    }
  }
  if (p !== size) throw new Error(`chunk pack length drift ${p} != ${size}`);
  return buf;
}

/** Open a payload frame; keeps the buffer and exposes typed views plus voxel access. */
export function openChunk(buf) {
  if (buf.length < 32) throw new Error(`short chunk frame: ${buf.length} bytes`);
  if (buf.subarray(0, 8).toString('ascii') !== CHUNK_MAGIC) throw new Error('bad chunk magic');
  // typed-array views need an aligned start, and a frame inside a batch container (or a Node Buffer
  // pool) may not sit on one, so take an owned copy when needed. A fetched ArrayBuffer in the
  // browser always starts at 0, so this never fires there.
  if ((buf.byteOffset & 3) !== 0) {
    const copy = new Uint8Array(buf.length);
    copy.set(buf);
    buf = Buffer.from(copy.buffer, 0, buf.length);
  }
  const version = buf.readUInt16LE(8);
  if (version !== CHUNK_VERSION) throw new Error(`chunk payload version ${version}`);
  const flags = buf.readUInt16LE(10);
  const cx = buf.readInt32LE(12), cz = buf.readInt32LE(16), yMin = buf.readInt32LE(20);
  const yCount = buf.readUInt16LE(24), paletteLen = buf.readUInt16LE(26), unknownStates = buf.readUInt32LE(28);
  let p = 32;
  const palette = new Uint16Array(buf.buffer, buf.byteOffset + p, paletteLen); p += paletteLen * 2;
  p = (p + 3) & ~3;                                 // palette padding, see packChunk
  const words = Math.ceil(yCount / 32);
  const mask = new Uint32Array(buf.buffer, buf.byteOffset + p, words); p += words * 4;
  const sections = [], byY = new Map();
  for (let s = 0; s < yCount; s++) {
    if (!(mask[s >>> 5] & (1 << (s & 31)))) continue;
    const single = buf.readUInt16LE(p); p += 2;
    let vox = null;
    if (!single) {
      vox = new Uint16Array(buf.buffer, buf.byteOffset + p, 4096); p += 4096 * 2;
    }
    const sec = { y: yMin + s, single, vox };
    sections.push(sec); byY.set(sec.y, sec);
  }
  if (flags & FLAG_LIGHT) {
    for (const sec of sections) { sec.sky = buf.readUInt8(p); p += 1; sec.blk = buf.readUInt8(p); p += 1; }
    for (const sec of sections) {
      if (sec.sky === LIGHT_VARIES) { sec.skyArr = new Uint8Array(buf.buffer, buf.byteOffset + p, 2048); p += 2048; }
      if (sec.blk === LIGHT_VARIES) { sec.blkArr = new Uint8Array(buf.buffer, buf.byteOffset + p, 2048); p += 2048; }
    }
  }
  let height = null, heightMotion = null;
  if (flags & FLAG_HEIGHT) { height = new Uint16Array(buf.buffer, buf.byteOffset + p, 256); p += 512; }
  if (flags & FLAG_HEIGHT_MOTION) { heightMotion = new Uint16Array(buf.buffer, buf.byteOffset + p, 256); p += 512; }
  let blockEntities = null;
  if (flags & FLAG_BE) {
    const n = buf.readUInt16LE(p); p += 2;
    const list = [];
    for (let i = 0; i < n; i++) {
      const x = buf.readInt32LE(p); p += 4;
      const y = buf.readInt32LE(p); p += 4;
      const z = buf.readInt32LE(p); p += 4;
      const id = buf.readUInt8(p); p += 1;
      list.push({ x, y, z, id });
    }
    const tn = buf.readUInt8(p); p += 1;
    const table = [];
    for (let i = 0; i < tn; i++) {
      const l = buf.readUInt8(p); p += 1;
      table.push(buf.toString('utf8', p, p + l)); p += l;
    }
    blockEntities = { list, table };
  }
  if (p !== buf.length) throw new Error(`chunk frame length drift ${p} != ${buf.length}`);
  return {
    cx, cz, yMin, yCount, palette, sections, height, heightMotion, blockEntities, unknownStates,
    classicSections: !!(flags & FLAG_CLASSIC),
    /** the section covering a world y, or null */
    sectionAt(y) { return byY.get(y >> 4) ?? null; },
    /** global state id at a block coordinate, or 0 outside the chunk */
    stateAt(x, y, z) {
      const s = byY.get(y >> 4);
      if (!s) return 0;
      return palette[s.single ? s.single - 1 : s.vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]];
    },
    /** highest block that counts in a column (chunk-local x,z), or yMin*16 - 1 when empty */
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
