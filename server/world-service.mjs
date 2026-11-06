// The decode/cache layer behind worldd. Kept separate from the HTTP handler so tests (and a future
// shell pass that wants whole regions) can use it directly.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import { listDims, dimExtent } from './world-dims.mjs';
import { decodeChunk, packChunk } from './chunk-payload.mjs';
import { shellFromPayload, shellFrameCols } from './shell.mjs';
import {
  BATCH_MAGIC, OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_HEADER, OVERVIEW_CELL_BYTES,
} from '../shared/chunk-format.mjs';
import { ShellPack } from './shell-pack.mjs';
import { loadLodTile, listLodTiles, lodPath } from './lod-pack.mjs';
import { LOD_HEADER, LOD_BYTES_PER_VERT } from '../shared/lod-format.mjs';

const MAX_OPEN_REGIONS = 24;
// A payload on disk is 124 KB of voxel truth; the wire only ever needs 6-9 KB of it. Storing it raw
// meant one whole-world sweep = 35 GB of cache for 25 minutes of saved CPU, and 1.4 M small files made
// the directory unusable (du alone ran for minutes). Compressed cache files are sniffed by prefix, so
// older uncompressed ones in the same tree still read correctly.
const CZIP = Buffer.from('DVZ1');
const CACHE_SWEEP_MIN_MS = 60000;
// A missing shell pack is remembered so an unbaked world does not stat the same path thousands of
// times per view, but it has to expire: `npm run bake:shells` can finish while the server is up, and a
// permanent negative is a server that never notices its far view got cheap.
const PACK_MISS_MS = 30000;
// Chunks of synchronous decode work between event-loop yields. One 32x32 shell batch over an unbaked
// region is ~1000 decodes, ~13 s of frozen server if it runs as one loop; a browser watching that
// reports "a full second per chunk" because its detail requests queued behind it.
const YIELD_EVERY = 48;
const yieldNow = () => new Promise((r) => setImmediate(r));
export { BATCH_MAGIC };

/**
 * Short content hash of a state-id table.
 *
 * A cached payload is a list of *global state ids*, so it only means anything next to the atlas that
 * numbered them. Without this tag `build/cache` is one flat namespace: re-pack the atlas (ids move)
 * and yesterday's payloads are served as if they still named the same blocks, and two services with
 * different tables - the server and a test's synthetic one - read each other's files and produce
 * failures that depend on which test happened to run first.
 */
export function tableTag(stateIds) {
  let h = 0x811c9dc5;
  const get = (i) => (typeof stateIds.length === 'number' ? stateIds[i] : undefined);
  if (stateIds instanceof Map) {
    // Hash the key with its id. Ids are assigned 1..N in table order, so hashing the values alone is
    // hashing N: re-pack the atlas with one block swapped for another and every payload id after it
    // means something else while the tag sits there unchanged.
    let n = 0;
    for (const [k, v] of stateIds) {
      n++;
      const key = String(k);
      for (let i = 0; i < key.length; i++) { h = (h ^ key.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
      h = (h ^ (v & 0xffff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
      h = (h ^ (v >>> 16)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ n) >>> 0;
  } else {
    for (let i = 0; i < stateIds.length; i++) {
      const v = get(i) ?? 0;
      h = (h ^ (v & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
      h = (h ^ ((v >>> 8) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export class WorldService {
  /**
   * @param worldRoot  e.g. DarkRPG/world
   * @param stateIds   Map<state key, u16 id> from the packed assets
   * @param cacheDir   decoded-payload cache, or null to disable
   * @param opts       {isCubeState, packDir, stamp} - packDir is a directory of shell packs baked by
   *                   server/bake-shells.mjs; with it a far-view shell is a file read instead of an
   *                   NBT decode. stamp is the atlas identity the packs were baked against.
   */
  constructor(worldRoot, stateIds, cacheDir = 'build/cache', opts = {}) {
    this.worldRoot = worldRoot;
    this.stateIds = stateIds;
    this.cacheDir = cacheDir;
    // state id -> "does this state render as a full cube?", from the packed assets. The shell pass
    // uses it to look past flowers, signs and saplings to the block a column is really made of.
    this.isCubeState = opts.isCubeState ?? null;
    // Which block a far column may be *painted* with (solid and opaque) versus which one is solid
    // enough to hold a surface up (water is). shell.mjs needs both to see through a lake.
    this.isPaintState = opts.isPaintState ?? opts.isCubeState ?? null;
    this.isSolidState = opts.isSolidState ?? opts.isCubeState ?? null;
    this.packDir = opts.packDir ?? null;
    // Baked coarse LOD tiles (server/bake-lod.mjs): the whole world pre-meshed at 16 blocks per
    // column, so the far view costs a file read instead of meshing on every pan and zoom.
    this.lodDir = opts.lodDir ?? null;
    this.lods = new Map();               // "key|rx,rz" -> tile image bytes (null = confirmed absent)
    this.stamp = opts.stamp ?? null;
    // Payload files hold global state ids, so they are only meaningful next to the state table they
    // were encoded against. Namespace the cache by that table: a re-pack renumbers ids, and two
    // services with different tables (a test's synthetic one, say) must never read each other's files.
    this.tableTag = opts.tableTag ?? tableTag(stateIds);
    // Payloads now carry light; a cache written before that must never be served as if it were lit.
    this.lightTag = opts.lightTag ?? (opts.light === false ? 'nolight' : 'lit');
    this.opts = opts;
    this.packs = new Map();            // "key|rx,rz" -> ShellPack (~1 MB inflated each)
    this.packMissAt = new Map();       // same key -> when we last confirmed there is no pack
    this.overviews = new Map();        // dim key -> overview bytes (or null when unbaked)
    this.shells = new Map();          // "dim/cx,cz" -> frame bytes (empty = confirmed absent)
    this.shellOrder = [];
    this.maxShells = opts.maxShells ?? 30000;
    this.dims = new Map();
    for (const d of listDims(worldRoot)) {
      const dir = path.join(worldRoot, d.dir);
      this.dims.set(d.id, { ...d, dir, key: d.dir.replace(/[/\\]/g, '_'), ...dimExtent(dir) });
    }
    this.regions = new Map();          // path -> { rgn, mtime }
    this.order = [];                  // LRU of region paths
    this.stats = { cacheHits: 0, decodes: 0, empty: 0, regionOpens: 0, cacheWrites: 0, cacheBytes: 0, cachePruned: 0 };
    // 0 disables; the running total of what this process has written is the trip wire, so the cap
    // costs nothing until it is actually exceeded.
    // cacheMaxBytes is bytes; cacheMaxGb is the flag form the server takes.
    this.cacheMaxBytes = Math.max(0, +(opts.cacheMaxBytes ?? +(+opts.cacheMaxGb || 0) * 1e9));
    this._lastSweep = 0;
    this._sinceSweep = 0;
  }

  dimList() {
    return [...this.dims.values()].map(d => ({
      id: d.id, dir: d.dir, key: d.key,
      regions: d.regions, chunkExtent: d.chunkExtent, regionExtent: d.regionExtent,
      chunksUpperBound: d.chunksUpperBound,
    }));
  }

  /** does this dimension have skylight at all? (the nether does not) */
  dimHasSky(dim) {
    if (this.opts?.dimHasSky) return this.opts.dimHasSky(dim);
    const id = String(dim?.id ?? dim ?? '');
    return !/nether/.test(id);
  }

  resolve(dim) {
    const d = this.dims.get(dim) ?? this.dims.get(shortName(dim));
    if (!d) throw new Error(`unknown dimension '${dim}' (have: ${[...this.dims.keys()].join(', ')})`);
    return d;
  }

  #regionFile(dim, rx, rz) {
    const p = path.join(dim.dir, `r.${rx}.${rz}.mca`);
    let hit = this.regions.get(p);
    if (hit) {
      this.#touch(p);
      return hit.rgn;
    }
    if (!fs.existsSync(p)) { this.regions.set(p, { rgn: null, mtime: 0 }); return null; }
    const mtime = fs.statSync(p).mtimeMs;
    const rgn = new RegionFile(p);
    this.stats.regionOpens++;
    this.regions.set(p, { rgn, mtime });
    this.#touch(p);
    while (this.order.length > MAX_OPEN_REGIONS) {
      const old = this.order.shift();
      const e = this.regions.get(old);
      if (e?.rgn) e.rgn.close();
      // keep the negative (missing file) entries forever, they are cheap and avoid repeated stat()
      if (!e?.rgn) this.order.push(old); else this.regions.delete(old);
    }
    return rgn;
  }

  #touch(p) {
    const i = this.order.indexOf(p);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(p);
  }

  #cachePath(dim, cx, cz) {
    return path.join(this.cacheDir, this.tableTag, this.lightTag, dim.key, `${cx}_${cz}.bin`);
  }

  /** Decoded payload bytes for one chunk, or null when the chunk is not generated. */
  chunkBytes(dimId, cx, cz, { fresh = false } = {}) {
    const dim = this.resolve(dimId);
    const rx = cx >> 5, rz = cz >> 5;
    const lx = cx & 31, lz = cz & 31;
    const cpath = this.cacheDir ? this.#cachePath(dim, cx, cz) : null;

    if (cpath && !fresh) {
      try {
        const st = fs.statSync(cpath);
        const rpath = path.join(dim.dir, `r.${rx}.${rz}.mca`);
        const rm = fs.existsSync(rpath) ? fs.statSync(rpath).mtimeMs : 0;
        if (st.size > 0 && st.mtimeMs >= rm) {
          this.stats.cacheHits++;
          return this.#uncache(fs.readFileSync(cpath));
        }
      } catch { /* miss */ }
    }

    const rgn = this.#regionFile(dim, rx, rz);
    if (!rgn) { this.stats.empty++; return null; }
    const raw = rgn.readChunkNbtBytes(lx, lz);
    if (!raw) { this.stats.empty++; if (cpath) this.#writeCache(cpath, null); return null; }
    // The region header says where the chunk is; its NBT xPos/zPos are unreliable in old saves, so
    // the payload position always comes from the header entry.
    const nbt = readNbt(zlib.inflateSync(raw)).value;
    nbt.xPos = cx; nbt.zPos = cz;
    // Skylight is per dimension: the nether writes no SkyLight array and no marker at all, so the
  // "open sky above the terrain" resolution must not be applied there (PLAN 8.2).
  const decoded = decodeChunk(nbt, this.stateIds, { dimHasSky: this.dimHasSky(dim) });
    this.stats.decodes++;
    if (!decoded) { if (cpath) this.#writeCache(cpath, null); return null; }
    const bytes = packChunk(decoded);
    if (cpath) this.#writeCache(cpath, bytes);
    return bytes;
  }

  /** A rectangle of payloads in one container frame: fewer requests for a chunk ring. */
  batchBytes(dimId, cx0, cz0, w, h) {
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) frames.push(this.chunkBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
    }
    return packBatch(frames);
  }

  /**
   * Heightmap-only frame for the far view (see server/shell.mjs). Cached in memory because it is
   * derived from a payload we may already hold, and re-deriving it costs a chunk parse.
   */
  shellBytes(dimId, cx, cz) {
    const dim = this.resolve(dimId);
    const key = `${dim.key}/${cx},${cz}`;
    const hit = this.shells.get(key);
    if (hit !== undefined) return hit || null;
    // A baked pack is a column read; only an unbaked region pays for a chunk decode.
    const packed = this.packFor(dim, cx >> 5, cz >> 5);
    let frame = null;
    if (packed) {
      const cols = packed.cols(cx, cz);
      // Four planes, in frame order. Passing the old (h, s) pair here reads the pack's cover plane as
      // the ground plane and paints the world with garbage.
      frame = cols && shellFrameCols(cx, cz, cols.h, cols.cover, cols.g, cols.s, cols.light);
    } else {
      const bytes = this.chunkBytes(dimId, cx, cz);
      frame = bytes
        ? shellFromPayload(bytes, { isPaint: this.isPaintState, isSolid: this.isSolidState,
            hasSky: this.dimHasSky(dim) }) : null;
    }
    this.shells.set(key, frame ?? Buffer.alloc(0));
    this.shellOrder.push(key);
    // FIFO, not LRU: a shell is a chunk parse, so re-deriving an evicted one is cheap, and keeping
    // a 30 000 entry list in least-recently-used order would cost more than the cache saves.
    while (this.shellOrder.length > this.maxShells) {
      const old = this.shellOrder.shift();
      this.shells.delete(old);
    }
    return frame;
  }

  /**
   * Batch form that yields between chunks, for the request path. The sync version above stays for the
   * bake and the tests, where nothing else needs the thread.
   */
  async batchBytesAsync(dimId, cx0, cz0, w, h, every = YIELD_EVERY) {
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        frames.push(this.chunkBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
        if (every > 0 && frames.length % every === 0) await yieldNow();
      }
    }
    return packBatch(frames);
  }

  async shellBatchBytesAsync(dimId, cx0, cz0, w, h, every = YIELD_EVERY) {
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        frames.push(this.shellBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
        if (every > 0 && frames.length % every === 0) await yieldNow();
      }
    }
    return packBatch(frames);
  }

  shellBatchBytes(dimId, cx0, cz0, w, h) {
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) frames.push(this.shellBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
    }
    return packBatch(frames);
  }

  /** Baked shell pack for a region, or null when packs are absent or baked against another atlas. */
  packFor(dim, rx, rz) {
    if (!this.packDir || this.stamp === null) return null;
    const k = `${dim.key}|${rx},${rz}`;
    const hit = this.packs.get(k);
    if (hit !== undefined && (hit || Date.now() - (this.packMissAt.get(k) ?? 0) <= PACK_MISS_MS)) {
      return hit || null;
    }
    // A pack older than this code is not a server error, it is unbaked ground: fall back to deriving
    // the shell from the chunk, and say once why. Without this, re-baking (which rewrites packs one at
    // a time while a viewer is connected) turns every request for a not-yet-rewritten region into a
    // 500, and the far view goes full-screen hole for the hour the bake takes.
    let p;
    try {
      p = ShellPack.load(path.join(this.packDir, dim.key, `${rx}_${rz}.bin`), this.stamp);
    } catch (e) {
      if (!this.packError) this.packError = `${k}: ${e.message}`;
      p = null;
    }
    this.packs.set(k, p);
    if (p) this.packMissAt.delete(k); else this.packMissAt.set(k, Date.now());
    while (this.packs.size > 64) this.packs.delete(this.packs.keys().next().value);
    return p;
  }

  /**
   * A baked coarse LOD tile for one region, as the uncompressed image bytes the browser reads
   * (shared/lod-format.mjs). The file stores its vertex body deflated; inflating here - about 1 ms
   * for a 450 KB tile - keeps any decompressor out of the browser.
   */
  lodBytes(dimId, cell, rx, rz) {
    if (!this.lodDir || this.stamp === null) return null;
    const dim = this.resolve(dimId);
    const k = `${dim.key}|${cell},${rx},${rz}`;
    if (this.lods.has(k)) return this.lods.get(k);
    let img = null;
    try {
      const t = loadLodTile(lodPath(path.join(this.lodDir, dim.key), cell, rx, rz), this.stamp);
      img = Buffer.alloc(LOD_HEADER + t.verts * LOD_BYTES_PER_VERT);
      img.set(t.head, 0);                      // magic, version, stamp, region, policy
      img.set(Buffer.from(t.pos.buffer, t.pos.byteOffset, t.verts * 12), LOD_HEADER);
      img.set(Buffer.from(t.col.buffer, t.col.byteOffset, t.verts * 4), LOD_HEADER + t.verts * 12);
      // The header as read carries the file's deflated length; the image's is what the browser
      // validates against, so rewrite it.
      img.writeUInt32LE(t.verts * LOD_BYTES_PER_VERT, 24);
      this.lodError = null;
    } catch (e) {
      this.lodError = `${k}: ${e.message}`;
    }
    this.lods.set(k, img);
    while (this.lods.size > 24) this.lods.delete(this.lods.keys().next().value);
    return img;
  }

  /** Which regions have tiles, and at which rung: [cell,rx,rz]. Without this the browser would ask
   *  for every region slot in the bounding box, and a save with 327 packed regions inside a 1 734
   *  slot box spends its first seconds on 1 400 empty requests - then does it again for every rung. */
  lodIndex(dimId) {
    if (!this.lodDir) return [];
    try {
      const dim = this.resolve(dimId);
      return listLodTiles(path.join(this.lodDir, dim.key)).map((t) => [t.cell, t.rx, t.rz]);
    } catch { return []; }
  }

  /** Any baked tiles at all for a dimension - what lets the browser turn the layer on by default. */
  hasLod(dimId) {
    if (!this.lodDir) return false;
    try {
      const dim = this.resolve(dimId);
      return listLodTiles(path.join(this.lodDir, dim.key)).length > 0;
    } catch { return false; }
  }

  /**
   * The whole dimension as one decimated heightmap grid, one frame (not a batch). Baked next to the
   * shell packs; null when they have not been baked, which is what makes the browser fall back to
   * streaming chunk shells.
   */
  overviewBytes(dimId) {
    const dim = this.resolve(dimId);
    if (!this.packDir || this.stamp === null) return null;
    if (this.overviews.has(dim.key)) return this.overviews.get(dim.key) || null;
    let buf = null;
    try {
      const b = fs.readFileSync(path.join(this.packDir, `overview-${dim.key}.bin`));
      const cells = b.readUInt16LE(24) * b.readUInt16LE(26);
      if (b.subarray(0, 8).toString('ascii') === OVERVIEW_MAGIC
          && b.readUInt16LE(8) === OVERVIEW_VERSION
          && b.readUInt32LE(12) === this.stamp
          && b.length === OVERVIEW_HEADER + cells * OVERVIEW_CELL_BYTES)
        buf = b;   // four u16 planes plus one light byte per cell
    } catch { /* not baked */ }
    this.overviews.set(dim.key, buf ?? Buffer.alloc(0));
    return buf;
  }

  /** Cache files carry a 4-byte prefix when deflated; a raw payload starts with CHUNK_MAGIC. */
  #cacheFile(bytes) {
    if (!bytes) return Buffer.alloc(0);
    const z = zlib.deflateSync(bytes, { level: 6 });
    return z.length + 4 < bytes.length ? Buffer.concat([CZIP, z]) : bytes;
  }

  #uncache(buf) {
    return buf.length > 4 && CZIP.equals(buf.subarray(0, 4)) ? zlib.inflateSync(buf.subarray(4)) : buf;
  }

  /**
   * Keep the payload cache inside a size budget by dropping the least recently written files. The
   * cache is saved CPU, never data, so evicting is always safe - it costs a re-decode, not a repair.
   */
  #sweepCache() {
    const root = path.join(this.cacheDir, String(this.tableTag), this.lightTag);
    if (!fs.existsSync(root)) return;
    const files = [];
    let total = 0;
    const walk = (d) => {
      let ent;
      try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ent) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          try { const st = fs.statSync(p); files.push([p, st.mtimeMs, st.size]); total += st.size; }
          catch { /* raced */ }
        }
      }
    };
    walk(root);
    if (total <= this.cacheMaxBytes) { this.stats.cacheBytes = total; return; }
    files.sort((a, b) => a[1] - b[1]);
    let freed = 0, gone = 0;
    for (const [p, , sz] of files) {
      if (total - freed <= this.cacheMaxBytes) break;
      try { fs.rmSync(p); freed += sz; gone++; } catch { /* raced */ }
    }
    this.stats.cachePruned += gone;
    this.stats.cacheBytes = total - freed;
    console.log(`  cache: over ${(this.cacheMaxBytes / 1e9).toFixed(1)} GB, dropped ${gone} payloads ` +
      +(`(freed ${(freed / 1e9).toFixed(2)} GB, ${(files.length - gone)} kept)`));
  }

  #noteCacheWrite(sz) {
    this.stats.cacheWrites++;
    this.stats.cacheBytes += sz;
    this._sinceSweep += sz;
    if (!this.cacheMaxBytes) return;
    const now = Date.now();
    if (this.stats.cacheBytes < this.cacheMaxBytes * 1.25) return;
    // A time floor stops a big cache being swept every write; a bytes floor keeps the cap honest when
    // the budget is small (tests, or a --cache-max-gb set low on purpose).
    if (now - this._lastSweep < CACHE_SWEEP_MIN_MS && this._sinceSweep < this.cacheMaxBytes * 2) return;
    this._lastSweep = now;
    this._sinceSweep = 0;
    this.stats.cacheBytes = 0;
    this.#sweepCache();
  }

  #writeCache(cpath, bytes) {
    fs.mkdirSync(path.dirname(cpath), { recursive: true });
    // Write-then-rename, not write-in-place. Tests run in parallel over the same cache directory, and
    // a reader that catches a half-written payload gets a short frame which `openChunk` will happily
    // walk off the end of - historically a "frame length drift" failure in an unrelated test.
    const tmp = `${cpath}.tmp${process.pid}`;
    const out = this.#cacheFile(bytes);
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, cpath);
    this.#noteCacheWrite(out.length);
  }
}

const SHORT = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' };
const shortName = (dim) => SHORT[dim] ?? dim;

/** Frames are 4-byte aligned: chunk payloads are read through typed-array views, and a view needs
 *  its byte offset to be a multiple of its element size. Empty frames mean "no such chunk". */
export function packBatch(frames) {
  let total = 8 + 4;
  for (const b of frames) total += 4 + ((b.length + 3) & ~3);
  const out = Buffer.alloc(total);
  let p = 0;
  out.write(BATCH_MAGIC, p, 'ascii'); p += 8;
  out.writeUInt32LE(frames.length, p); p += 4;
  for (const f of frames) {
    out.writeUInt32LE(f.length, p); p += 4;
    if (f.length) f.copy(out, p);
    p += (f.length + 3) & ~3;
  }
  return out;
}

/** gzip on demand: voxel payloads are ~90% redundant, and fetch() decompresses transparently. */
export function compress(bytes) { return zlib.gzipSync(bytes, { level: 6 }); }
