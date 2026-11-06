// Shell packs: the far-view heightmap skin, precomputed once instead of re-derived per request.
//
// Without this, asking for the skin at radius 96 costs a full voxel decode of ~37 000 chunks -
// inflate ~100 KB of NBT and unpack every section - to ship 1 KB per chunk back. That is what made
// the far view crawl. A pack is one file per world region holding just the (height, state) columns,
// so serving a shell batch is an inflate of ~1 MB plus a memcpy, and the whole dimension can be
// swept in a fraction of a second.
//
// Layout, one file per region (build/shells/<dimkey>/<rx>_<rz>.bin):
//   0  magic 'DVSHRP2 '
//   8  u16 version
//  10  u16 flags
//  12  i16 rx, 14 i16 rz, 16 u32 stamp (atlas identity: state ids must match the baked atlas)
//  20  u32 compLen
//  24  128 B presence bitmap, bit ((z&31)<<5 | (x&31))
// 152  deflate(raw) where raw is 1024 slots x (256 u16 surface, 256 u16 cover, 256 u16 ground,
//      256 u16 state, 256 light bytes), slot-major - the same planes a shell frame carries
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// The magic is a container tag; PACK_VERSION is what invalidates a pack. v4 = `ground` is the surface
// a cell stands on, not the top of whatever happens to be standing on it, and `state` is the paint.
// Old v3 packs are rejected by the version check rather than quietly mis-drawing the world.
export const PACK_MAGIC = 'DVSHRP3 ';
export const PACK_VERSION = 4;          // v4: a pack now stores the ground under a canopy, not the trunk top
export const PACK_HEADER = 24;
export const PACK_SLOTS = 1024;          // 32x32 chunks, the world/region granularity
export const SLOT_COLS = 256;            // columns per chunk
// Four u16 planes per chunk slot: surface height, cover state, ground height, paint state. Same
// order as server/shell.mjs writes into a shell frame, so a bake can copy frame bytes straight in.
export const SLOT_PLANES = 4;
// ...plus one light byte per column, so a pack can carry the save's shading to the far view.
export const SLOT_LIGHT_BYTES = SLOT_COLS;
export const SLOT_BYTES = SLOT_COLS * 2 * SLOT_PLANES + SLOT_LIGHT_BYTES;
export const RAW_BYTES = PACK_SLOTS * SLOT_BYTES;

export const slotOf = (cx, cz) => ((cz & 31) << 5) | (cx & 31);
export const packPath = (dir, rx, rz) => path.join(dir, `${rx}_${rz}.bin`);

/** @returns {Buffer} a pack file, ready to write */
export function packBytes(rx, rz, stamp, slots) {
  const raw = Buffer.alloc(RAW_BYTES);
  const bitmap = Buffer.alloc(128);
  for (const [cx, cz, h, cover, g, st, light] of slots) {
    const off = slotOf(cx, cz) * SLOT_BYTES;
    const plane = (n, src) => Buffer.from(src.buffer, src.byteOffset, SLOT_COLS * 2)
      .copy(raw, off + n * SLOT_COLS * 2);
    plane(0, h); plane(1, cover); plane(2, g); plane(3, st);
    if (light) Buffer.from(light.buffer, light.byteOffset, SLOT_COLS)
      .copy(raw, off + SLOT_COLS * 2 * SLOT_PLANES);
    bitmap[slotOf(cx, cz) >> 3] |= 1 << (slotOf(cx, cz) & 7);
  }
  const comp = zlib.deflateSync(raw, { level: 6 });
  const out = Buffer.alloc(PACK_HEADER + 128 + comp.length);
  out.write(PACK_MAGIC, 0, 'ascii');
  out.writeUInt16LE(PACK_VERSION, 8);
  out.writeUInt16LE(0, 10);
  out.writeInt16LE(rx, 12);
  out.writeInt16LE(rz, 14);
  out.writeUInt32LE(stamp >>> 0, 16);
  out.writeUInt32LE(comp.length, 20);
  bitmap.copy(out, PACK_HEADER);
  comp.copy(out, PACK_HEADER + 128);
  return out;
}

/** A readable pack. Inflates lazily and keeps the raw grid while the object lives. */
export class ShellPack {
  /**
   * Open a pack, or null when the file is missing or was baked against a different atlas. State ids
   * are only meaningful against the atlas they came from, so a stamp mismatch has to fail closed.
   */
  static load(file, stamp = null) {
    let p;
    try { p = new ShellPack(file); } catch { return null; }
    if (stamp !== null && p.stamp !== (stamp >>> 0)) return null;
    return p;
  }

  constructor(file) {
    this.file = file;
    const head = Buffer.alloc(PACK_HEADER + 128);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    if (head.toString('ascii', 0, 8) !== PACK_MAGIC) throw new Error(`bad shell pack magic in ${file}`);
    if (head.readUInt16LE(8) !== PACK_VERSION) throw new Error(`shell pack version ${head.readUInt16LE(8)} in ${file}`);
    this.rx = head.readInt16LE(12);
    this.rz = head.readInt16LE(14);
    this.stamp = head.readUInt32LE(16);
    this.compLen = head.readUInt32LE(20);
    this.bitmap = head.subarray(PACK_HEADER, PACK_HEADER + 128);
    this.raw = null;
  }

  has(cx, cz) {
    const k = slotOf(cx, cz);
    return (this.bitmap[k >> 3] & (1 << (k & 7))) !== 0;
  }

  /** Inflate the whole region grid once: 1 MB, ~1 ms, and every later lookup is a view. */
  ensure() {
    if (this.raw) return this.raw;
    const buf = Buffer.alloc(this.compLen);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, this.compLen, PACK_HEADER + 128); } finally { fs.closeSync(fd); }
    this.raw = zlib.inflateSync(buf);
    return this.raw;
  }

  /**
   * Read one chunk's columns out of the grid.
   * @returns {{h: Uint16Array, s: Uint16Array}|null} views into the inflated grid (do not keep
   *          them past a `free()`), or null where the chunk is absent
   */
  cols(cx, cz) {
    if (!this.has(cx, cz)) return null;
    const raw = this.ensure();
    const off = slotOf(cx, cz) * SLOT_BYTES;
    const view = (n) => new Uint16Array(raw.buffer, raw.byteOffset + off + n * SLOT_COLS * 2, SLOT_COLS);
    const light = new Uint8Array(raw.buffer, raw.byteOffset + off + SLOT_COLS * 2 * SLOT_PLANES, SLOT_COLS);
    return { h: view(0), cover: view(1), g: view(2), s: view(3), light };
  }

  free() { this.raw = null; }
}

/** Which column speaks for a group of columns: the one nearest the 80th percentile of height. The
 * maximum lets a single tree stand for 256 columns; the median shaves a whole forest down to a plain.
 * 0.8 keeps the canopy of a forest without the spikes, and it is the same rule the browser shell
 * mesher uses (CELL_PCTL), so the coarse grid and the skin agree instead of popping into each other. */
export const PACK_PCTL = 0.8;

/**
 * Sweep every pack of a dimension and reduce it to one column per `cell` x `cell` chunks.
 *
 * Two passes on purpose: first one representative column per chunk, then the same percentile choice
 * across each cell's chunk representatives. Both passes carry the pair (surface, ground) plus the
 * paint and cover states of the column that won, so the browser can pick a height field per tier -
 * canopy near, terrain far - and still know what to paint it with and what sits on top of it.
 */
export function overviewFromPacks(dir, stamp, extent, cell = 4) {
  const [x0, x1] = [extent.minX, extent.maxX];
  const [z0, z1] = [extent.minZ, extent.maxZ];
  const gw = x1 - x0 + 1, gh = z1 - z0 + 1;               // chunk grid of the whole extent
  const w = Math.ceil(gw / cell), h = Math.ceil(gh / cell);
  const csurf = new Uint16Array(gw * gh);
  const cground = new Uint16Array(gw * gh);
  const cstate = new Uint16Array(gw * gh);
  const ccover = new Uint16Array(gw * gh);
  const clight = new Uint8Array(gw * gh);

  const hs = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.bin')).sort()) {
    const p = new ShellPack(path.join(dir, f));
    if (p.stamp !== stamp) { p.free(); continue; }        // atlas moved on; this pack is stale
    for (let cz = p.rz * 32; cz < p.rz * 32 + 32; cz++) {
      if (cz < z0 || cz > z1) continue;
      const row = (cz - z0) * gw;
      for (let cx = p.rx * 32; cx < p.rx * 32 + 32; cx++) {
        if (cx < x0 || cx > x1) continue;
        const c = p.cols(cx, cz);
        if (!c) continue;
        hs.length = 0;
        for (let i = 0; i < SLOT_COLS; i++) if (c.h[i]) hs.push(c.h[i]);
        if (!hs.length) continue;
        hs.sort((a, b) => a - b);
        const want = hs[Math.min(hs.length - 1, Math.floor(hs.length * PACK_PCTL))];
        let gap = Infinity, st = 0, gr = 0, cv = 0, lt = 0;
        for (let i = 0; i < SLOT_COLS; i++) {
          const d = Math.abs(c.h[i] - want);
          if (d < gap) { gap = d; st = c.s[i]; gr = c.g[i]; cv = c.cover[i]; lt = c.light ? c.light[i] : 0; }
        }
        const id = row + (cx - x0);
        csurf[id] = want; cground[id] = gr; cstate[id] = st; ccover[id] = cv; clight[id] = lt;
      }
    }
    p.free();
  }

  const height = new Uint16Array(w * h);
  const ground = new Uint16Array(w * h);
  const state = new Uint16Array(w * h);
  const cover = new Uint16Array(w * h);
  const light = new Uint8Array(w * h);
  const pick = [];
  for (let oz = 0; oz < h; oz++) {
    for (let ox = 0; ox < w; ox++) {
      pick.length = 0;
      for (let cz = oz * cell; cz < Math.min(gh, oz * cell + cell); cz++) {
        for (let cx = ox * cell; cx < Math.min(gw, ox * cell + cell); cx++) {
          const id = cz * gw + cx;
          if (csurf[id]) pick.push(id);
        }
      }
      if (!pick.length) continue;
      pick.sort((a, b) => csurf[a] - csurf[b]);
      const id = pick[Math.min(pick.length - 1, Math.floor(pick.length * PACK_PCTL))];
      const k = oz * w + ox;
      height[k] = csurf[id]; ground[k] = cground[id]; state[k] = cstate[id]; cover[k] = ccover[id];
      light[k] = clight[id];
    }
  }
  // Heights stay biased by HEIGHT_BIAS exactly as in a shell frame (server/shell.mjs): the arrays are
  // u16 and world Y goes below zero, so the bias is what keeps them representable. The browser strips
  // it, same as it does for shells. An empty cell is 0, i.e. -2048 once stripped, and paints nothing.
  return { w, h, x0, z0, cell, height, ground, state, cover, light };
}

/**
 * Identity of the baked atlas. Shell packs store global state ids, which are only meaningful against
 * the atlas they were baked from, so every derived file carries this and refuses to serve otherwise.
 */
export const atlasStamp = (stat, stateCount) =>
  (((stat.mtimeMs / 1000) | 0) ^ ((stateCount << 9) >>> 0)) >>> 0;
