// The decode/cache layer behind worldd. Kept separate from the HTTP handler so tests (and a future
// shell pass that wants whole regions) can use it directly.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import { listDims, dimExtent, levelSeed } from './world-dims.mjs';
import { worldTagFor, isWorldTag } from '../shared/world-tag.mjs';
import { packCells, makeReader, toWire } from '../shared/regionbits.mjs';
import { decodeChunk, packChunk } from './chunk-payload.mjs';
import { shellFromPayload, shellFrameCols } from './shell.mjs';
import {
  BATCH_MAGIC, OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_VERSION_MIN, OVERVIEW_HEADER,
  OVERVIEW_CELL_BYTES, overviewCellBytes, stateTableHash, BATCH_HEADER,
} from '../shared/chunk-format.mjs';
import { ShellPack } from './shell-pack.mjs';
import { loadLodTile, listLodTiles, lodPath } from './lod-pack.mjs';
import { LOD_HEADER, LOD_BYTES_PER_VERT } from '../shared/lod-format.mjs';

const MAX_OPEN_REGIONS = 48;
// Remembered "no such region file" answers. Generous, because the cost is one Map entry, and the
// alternative is a stat() per chunk slot of unwritten ground on every far pan.
const MAX_REMEMBERED_REGIONS = 200000;
// A payload on disk is 124 KB of voxel truth; the wire only ever needs 6-9 KB of it. Storing it raw
// meant one whole-world sweep = 35 GB of cache for 25 minutes of saved CPU, and 1.4 M small files made
// the directory unusable (du alone ran for minutes). Compressed cache files are sniffed by prefix, so
// older uncompressed ones in the same tree still read correctly.
const CZIP = Buffer.from('DVZ1');
const CACHE_SWEEP_MIN_MS = 60000;
// How many cache files one reconcile sweep will look at (and delete) before stopping. The cap keeps
// a sweep a bounded background job: the last full walk of this tree covered 665 427 files, and
// tools/cache-prune.mjs is the right way to clean a mess that big in one go.
const SWEEP_CAP = 60000;
// How many written files this process keeps in its eviction list. 8 GB of ~2 KB cache files is 4 M
// paths, and a path string is worth more than the payload it names, so the in-session list is a window;
// what falls out of the window is counted in baseBytes and left to the off-request reconcile sweep.
const MAX_TRACKED = 200000;
// A missing shell pack is remembered so an unbaked world does not stat the same path thousands of
// times per view, but it has to expire: `npm run bake:shells` can finish while the server is up, and a
// permanent negative is a server that never notices its far view got cheap.
const PACK_MISS_MS = 30000;
// Chunks of synchronous decode work between event-loop yields. One 32x32 shell batch over an unbaked
// region is ~1000 decodes, ~13 s of frozen server if it runs as one loop; a browser watching that
// reports "a full second per chunk" because its detail requests queued behind it.
const YIELD_EVERY = 48;
// How long a request path may hold the thread before it lets other work in. A slot count cannot be the
// only rule: 48 chunk slots of unwritten ground is ~0.1 ms of header reading, so a 64x64 far block
// inserted 85 event-loop turns into 10 ms of work, and every one of those turns then queued behind the
// other requests already in flight. Measured on build/dbg-farpan.mjs: an entirely empty 64x64 shell
// block took 435 ms of wall time for 10 ms of work.
const YIELD_MS = 4;
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
    // 'none' means no cache. It used to be taken as a directory name, and a WorldService built with
    // the usual 'none' sentinel quietly created ./none/<tag>/... next to the repo.
    this.cacheDir = cacheDir && cacheDir !== 'none' ? cacheDir : null;
    // state id -> "does this state render as a full cube?", from the packed assets. The shell pass
    // uses it to look past flowers, signs and saplings to the block a column is really made of.
    this.isCubeState = opts.isCubeState ?? null;
    // Which block a far column may be *painted* with (solid and opaque) versus which one is solid
    // enough to hold a surface up (water is). shell.mjs needs both to see through a lake.
    this.isPaintState = opts.isPaintState ?? opts.isCubeState ?? null;
    this.isSolidState = opts.isSolidState ?? opts.isCubeState ?? null;
    this.isFilmState = opts.isFilmState ?? null;   // water and ice hold a surface up but are not skin
    this.packDir = opts.packDir ?? null;
    // Baked coarse LOD tiles (server/bake-lod.mjs): the whole world pre-meshed at 16 blocks per
    // column, so the far view costs a file read instead of meshing on every pan and zoom.
    this.lodDir = opts.lodDir ?? null;
    this._lodIdx = new Map();              // dimKey -> {sig, list}: the served /lodindex body, cheap to redo
    this.lods = new Map();               // "key|rx,rz" -> tile image bytes (null = confirmed absent)
    this.stamp = opts.stamp ?? null;
    // Payload files hold global state ids, so they are only meaningful next to the state table they
    // were encoded against. Namespace the cache by that table: a re-pack renumbers ids, and two
    // services with different tables (a test's synthetic one, say) must never read each other's files.
    this.tableTag = opts.tableTag ?? tableTag(stateIds);
    // The same fact, in the form a *response* can carry: the browser holds the atlas, so it can name
    // the table it numbers blocks by, and an answer numbered against another table is refused rather
    // than drawn. `stateIds` is a Map in atlas order, which is the order the page indexes too.
    this.tableHash = opts.tableHash ?? stateTableHash(stateIds instanceof Map ? [...stateIds.keys()] : stateIds);
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
    // Which SAVE this is, for the payload cache (shared/world-tag.mjs). Without this level, two saves
    // with the same mod set read each other's decoded chunks: same table tag, same dimension key, same
    // frame, someone else's terrain - and no error anywhere to say so.
    this.worldTag = worldTagFor({
      dir: path.resolve(worldRoot), seed: levelSeed(worldRoot), override: opts.worldTag,
    });
    if (!isWorldTag(this.worldTag)) {
      // worldTagFor sanitizes, so this only fires on something deliberately hostile in --world-tag.
      throw new Error(`world tag '${this.worldTag}' is not a usable directory name (from --world-tag '${opts.worldTag}')`);
    }
    // What to print in the boot log about where this cache directory name came from. A caller that chose
    // the tag for its own reason (a --worlds folder, say) says so, because "from --world-tag probe" is a
    // lie about a flag nobody typed.
    this.worldTagFrom = opts.worldTagFrom
      || (opts.worldTag ? `--world-tag ${opts.worldTag}` : 'the world directory and its seed');
    this.regions = new Map();          // path -> { rgn, mtime } for open files, { rgn: null, seenAt } for misses
    this.order = [];                  // eviction list: open region files only, oldest first
    this.missingTtlMs = +(opts.missingTtlMs ?? 300000);
    // What this process wrote into the payload cache, oldest first: the eviction list. The bound used
    // to be a full walk of the cache tree, and that walk is not cheap - build/cache had grown to
    // 665 427 files holding 1.42 GB of payloads, 411 776 of them 0-byte "no such chunk" markers, and
    // walking it takes 98 s (build/dbg-cachewalk.mjs). A server that does not run its event loop for
    // 98 s is, to whoever is looking at the map, a server that died: heartbeats stop, requests pile up
    // in CLOSE_WAIT, and the viewport freezes on the last chunks it fetched.
    // Region coverage. A save's bounding box is not its coverage (this one: 1,394 cells, 437
    // files), and every far request walks the box. Absence here only ever short-circuits a walk
    // into the answer that walk would have given anyway, and the listing is refreshed on a TTL so
    // a region written later is not permanently invisible.
    this.coverage = new Map();
    this.coverageTtlMs = +(opts.coverageTtlMs ?? 30000);
    this.written = [];
    this.writtenBytes = 0;
    this.baseBytes = 0;               // cache bytes this process did not write (from a reconcile sweep)
    this._sweep = null;               // single-flight guard for sweepCacheBudget()
    this.stats = {
      cacheHits: 0, decodes: 0, empty: 0, holes: 0, regionOpens: 0, cacheWrites: 0, cacheBytes: 0,
      cachePruned: 0, sweeps: 0, sweepMs: 0, sweepFiles: 0,
      // missing: distinct region files remembered as absent; missHits: lookups answered from that
      // memory. A far pan's whole cost profile sits in these two numbers.
      missing: 0, missHits: 0,
      // coverageSkips: batch requests answered from the region listing instead of a slot walk.
      coverageSkips: 0, coverageSlots: 0,
    };
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

  /**
   * Which r.x.z files this dimension has, re-read from disk when the cached listing goes stale.
   * The startup listing is not enough: a server started while the world is still generating must
   * still notice a region file that appears later.
   */
  #coverageEntry(dimId) {
    const d = this.dims.get(dimId) ?? this.dims.get(shortName(dimId));
    if (!d) return null;
    const now = performance.now();
    const cur = this.coverage.get(d.key);
    if (cur && now - cur.at < this.coverageTtlMs) return cur;
    const cells = dimExtent(d.dir).cells ?? [];
    const grid = packCells(cells);
    const entry = { reader: makeReader(grid), wire: toWire(grid), cells: cells.length, at: now };
    this.coverage.set(d.key, entry);
    return entry;
  }

  /** Bit reader over the listing; empty for a dimension this server does not know. */
  coverageFor(dimId) {
    return this.#coverageEntry(dimId)?.reader ?? makeReader(null);
  }

  /**
   * Does any region file overlap this chunk rectangle? An unknown dimension or an empty listing says
   * yes: the point is to skip walks over ground that was never written, never to hide ground.
   */
  hasGround(dimId, cx0, cz0, w, h) {
    const e = this.#coverageEntry(dimId);
    if (!e || !e.cells) return true;
    return e.reader.hasAny(cx0, cz0, w, h);
  }

  /** JSON form for /regions, so the browser can stop asking for ground this save never had. */
  coverageWire(dimId) {
    const e = this.#coverageEntry(dimId);
    return e?.cells ? { ...e.wire, cells: e.cells } : null;
  }

  /** All-empty batch when coverage says the whole rectangle was never written; null otherwise. */
  #emptyBatchFor(dimId, cx0, cz0, w, h) {
    if (this.hasGround(dimId, cx0, cz0, w, h)) return null;
    this.stats.coverageSkips++; this.stats.coverageSlots += w * h;
    return packBatch(new Array(w * h).fill(Buffer.alloc(0)), this.tableHash);
  }

  #regionFile(dim, rx, rz) {
    const p = path.join(dim.dir, `r.${rx}.${rz}.mca`);
    const hit = this.regions.get(p);
    if (hit) {
      if (hit.rgn) { this.#touch(p); return hit.rgn; }
      // A remembered miss. It is deliberately NOT in the eviction list - there is no handle to close -
      // and it is only trusted for missingTtlMs, so a region file that appears later is still found.
      if (Date.now() - hit.seenAt <= this.missingTtlMs) { this.stats.missHits++; return null; }
      this.regions.delete(p);
    }
    if (!fs.existsSync(p)) {
      this.regions.set(p, { rgn: null, mtime: 0, seenAt: Date.now() });
      this.stats.missing++;
      // Remembering misses is the cheap answer to a far pan, but it is still memory: let go of the
      // oldest remembered misses (a Map keeps insertion order) well above what any save has.
      if (this.regions.size > MAX_REMEMBERED_REGIONS) {
        for (const k of this.regions.keys()) {
          if (this.regions.get(k)?.rgn) continue;
          this.regions.delete(k);
          if (this.regions.size <= MAX_REMEMBERED_REGIONS) break;
        }
      }
      return null;
    }
    const mtime = fs.statSync(p).mtimeMs;
    const rgn = new RegionFile(p);
    this.stats.regionOpens++;
    this.regions.set(p, { rgn, mtime });
    this.#touch(p);
    // `order` now holds only files that are actually open, so every entry in this loop is evictable
    // and the loop terminates. It used to hold remembered misses as well and re-queue each one, which
    // is a loop that cannot make progress: a pull-back touching the ~950 unwritten region slots inside
    // this save's own extent filled the list, and the next real open spun forever. That is the 11/07
    // "worldd is dead, I panned far out" wedge - the process was at 100 % CPU, not slow.
    while (this.order.length > MAX_OPEN_REGIONS) {
      const old = this.order.shift();
      const e = this.regions.get(old);
      if (e?.rgn) e.rgn.close();
      this.regions.delete(old);
    }
    return rgn;
  }

  /** Close and forget an open region: the next lookup re-opens it and re-reads its header. */
  #dropRegion(p) {
    const e = this.regions.get(p);
    if (!e) return;
    if (e.rgn) { try { e.rgn.close(); } catch { /* already gone */ } }
    this.regions.delete(p);
    const i = this.order.indexOf(p);
    if (i >= 0) this.order.splice(i, 1);
  }

  #touch(p) {
    const i = this.order.indexOf(p);
    if (i >= 0) this.order.splice(i, 1);
    this.order.push(p);
  }

  /**
   * Where one chunk's decoded payload lives, or null with no cache.
   *
   * Public on purpose: "would THIS save read that file?" is the question every cache question starts
   * with, and a probe or a test that cannot ask it can only infer it from a directory listing.
   */
  cachePath(dimId, cx, cz) {
    if (!this.cacheDir) return null;
    return this.#cachePath(this.resolve(dimId), cx, cz);
  }

  #cachePath(dim, cx, cz) {
    return path.join(this.cacheDir, this.worldTag, String(this.tableTag), this.lightTag,
      dim.key, `${cx}_${cz}.bin`);
  }

  /** Decoded payload bytes for one chunk, or null when the chunk is not generated. */
  chunkBytes(dimId, cx, cz, { fresh = false } = {}) {
    const dim = this.resolve(dimId);
    const rx = cx >> 5, rz = cz >> 5;
    const lx = cx & 31, lz = cz & 31;
    const cpath = this.cacheDir ? this.#cachePath(dim, cx, cz) : null;

    // Absence first, answered from the region header, before a single file in the cache directory is
    // touched. The header is read once when a region opens and entry() is a bit test, so "there is no
    // chunk here" costs nothing - and it has to, because pulling far back sweeps thousands of
    // unwritten slots a second. The old order stat'd the cache path and then left a 0-byte marker for
    // every hole: a million files, and a cache bound that could only be enforced by walking them.
    const rgn = this.#regionFile(dim, rx, rz);
    if (!rgn) { this.stats.empty++; return null; }
    if (!rgn.entry(lx, lz)) { this.stats.empty++; this.stats.holes++; return null; }

    if (cpath && !fresh) {
      try {
        const st = fs.statSync(cpath);
        const rpath = path.join(dim.dir, `r.${rx}.${rz}.mca`);
        const rm = fs.existsSync(rpath) ? fs.statSync(rpath).mtimeMs : 0;
        if (st.size > 0 && st.mtimeMs >= rm) {
          this.stats.cacheHits++;
          return this.#uncache(fs.readFileSync(cpath));
        }
        // The cache is older than the region: the save moved under us, so the header read at open time
        // may have too. Drop the open region so the next lookup re-opens it and re-reads the header.
        if (st.size > 0 && rm > st.mtimeMs) this.#dropRegion(path.join(dim.dir, `r.${rx}.${rz}.mca`));
      } catch { /* miss */ }
    }

    const raw = rgn.readChunkNbtBytes(lx, lz);
    // The header said this slot is present, so a null read means a bogus or raced entry - rare enough
    // to re-decide on the next request rather than leave a marker file behind for it.
    if (!raw) { this.stats.empty++; return null; }
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
    return packBatch(frames, this.tableHash);
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
      // Four u16 planes plus the light and surface-band bytes, in frame order. Passing the old
      // (h, s) pair here reads the pack's cover plane as the ground plane and paints the world with
      // garbage.
      frame = cols && shellFrameCols(cx, cz, cols.h, cols.cover, cols.g, cols.s, cols.light, cols.band);
    } else {
      const bytes = this.chunkBytes(dimId, cx, cz);
      frame = bytes
        ? shellFromPayload(bytes, { isPaint: this.isPaintState, isSolid: this.isSolidState,
            isFilm: this.isFilmState, hasSky: this.dimHasSky(dim) }) : null;
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
    const skip = this.#emptyBatchFor(dimId, cx0, cz0, w, h);
    if (skip) return skip;
    const frames = [];
    let due = performance.now() + YIELD_MS;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        frames.push(this.chunkBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
        // 'every' bounds how often the clock is consulted; the clock decides whether a yield is worth
        // taking. Decodes blow through 4 ms in a handful of chunks, so a heavy batch still interleaves.
        if (every > 0 && frames.length % every === 0 && performance.now() >= due) {
          await yieldNow();
          due = performance.now() + YIELD_MS;
        }
      }
    }
    return packBatch(frames, this.tableHash);
  }

  async shellBatchBytesAsync(dimId, cx0, cz0, w, h, every = YIELD_EVERY) {
    const skip = this.#emptyBatchFor(dimId, cx0, cz0, w, h);
    if (skip) return skip;
    const frames = [];
    let due = performance.now() + YIELD_MS;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        frames.push(this.shellBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
        if (every > 0 && frames.length % every === 0 && performance.now() >= due) {
          await yieldNow();
          due = performance.now() + YIELD_MS;
        }
      }
    }
    return packBatch(frames, this.tableHash);
  }

  shellBatchBytes(dimId, cx0, cz0, w, h) {
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) frames.push(this.shellBytes(dimId, cx0 + i, cz0 + j) ?? Buffer.alloc(0));
    }
    return packBatch(frames, this.tableHash);
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
    const dim = this.resolve(dimId);
    const dir = path.join(this.lodDir, dim.key);
    // [cell, rx, rz, verts]. The vertex count is in the index because the viewer budgets this layer
    // per tile, and the cost it uses must not come from the tiles it currently happens to hold - see
    // lodVertsOf in server/lod-pack.mjs for the failure that caused.
    //
    // Cached: building it reads a 24-byte header out of every tile file (~1 500 opens). The signature
    // is the mtime of the dimension folder and its rung folders, which is what changes when tiles are
    // baked or deleted; a rebake rewrites files inside a folder, so the folder mtime moves too.
    let sig;
    try {
      const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      sig = [fs.statSync(dir).mtimeMs, ...subs.map((s) => fs.statSync(path.join(dir, s)).mtimeMs)].join('|');
    } catch { return []; }
    const hit = this._lodIdx.get(dim.key);
    if (hit && hit.sig === sig) return hit.list;
    const list = listLodTiles(dir).map((t) => [t.cell, t.rx, t.rz, t.verts]);
    this._lodIdx.set(dim.key, { sig, list });
    return list;
  }

  /** Any baked tiles at all for a dimension - what lets the browser turn the layer on by default. */
  hasLod(dimId) {
    if (!this.lodDir) return false;
    // Same walk as the index, so /meta's "is anything baked" must not pay for a second one.
    return this.lodIndex(dimId).length > 0;
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
      const ver = b.readUInt16LE(8);
      // Four u16 planes plus a light byte per cell, plus a surface-band byte from v5 on.
      if (b.subarray(0, 8).toString('ascii') === OVERVIEW_MAGIC
          && ver >= OVERVIEW_VERSION_MIN && ver <= OVERVIEW_VERSION
          && b.readUInt32LE(12) === this.stamp
          && b.length === OVERVIEW_HEADER + cells * overviewCellBytes(ver))
        buf = b;
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
   * Keep the payload cache inside its budget using what this process wrote, oldest first. No tree walk
   * on the request path: the walk is what stalled the loop (see the constructor note), and cleaning up
   * generations this server never wrote is a janitorial job - tools/cache-prune.mjs, or the
   * off-request sweepCacheBudget() below.
   */
  #noteCacheWrite(p, sz) {
    this.stats.cacheWrites++;
    this.written.push([p, sz]);
    this.writtenBytes += sz;
    this.stats.cacheBytes = this.baseBytes + this.writtenBytes;
    if (!this.cacheMaxBytes) return;
    if (this.baseBytes + this.writtenBytes <= this.cacheMaxBytes) {
      // Keep the window bounded: what falls off the old end is still on disk, it just stops being
      // something this path can evict cheaply.
      if (this.written.length > MAX_TRACKED) {
        const cut = this.written.length - MAX_TRACKED;
        for (let i = 0; i < cut; i++) { this.baseBytes += this.written[i][1]; this.writtenBytes -= this.written[i][1]; }
        this.written.splice(0, cut);
      }
      return;
    }
    let freed = 0, gone = 0;
    while (this.written.length && this.baseBytes + this.writtenBytes > this.cacheMaxBytes * 0.9) {
      const [victim, sz2] = this.written.shift();
      try { fs.rmSync(victim, { force: true }); } catch { /* raced: someone else got there first */ }
      this.writtenBytes -= sz2; freed += sz2; gone++;
    }
    this.stats.cachePruned += gone;
    this.stats.cacheBytes = this.baseBytes + this.writtenBytes;
    if (gone) {
      // Steady-state eviction is a fact about the budget, not an event worth a line each time: with an
      // 8 GB cap and a busy pan this fires constantly, so it says so at most every 30 s.
      const now = Date.now();
      if (gone >= 50 || now - (this._lastEvictLog ?? 0) > 30000) {
        this._lastEvictLog = now;
        console.log(`  cache: over the ${(this.cacheMaxBytes / 1e9).toFixed(1)} GB budget - dropped ${gone} `
          + `payloads this server wrote (${(freed / 1e6).toFixed(1)} MB), cache ~`
          + `${(this.stats.cacheBytes / 1e9).toFixed(2)} GB, ${this.written.length} tracked`);
      }
      return;
    }
    // Nothing left that we wrote and still over budget: the overage is older generations. Reconcile
    // that off the request path, at most once a minute.
    const now = Date.now();
    if (now - this._lastSweep < CACHE_SWEEP_MIN_MS) return;
    this._lastSweep = now;
    this.sweepCacheBudget().catch((e) => console.log('  cache: sweep failed: ' + (e.message ?? e)));
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
    this.#noteCacheWrite(cpath, out.length);
  }

  /**
   * Reconcile the cache against its byte budget without blocking requests: async directory and stat
   * calls in chunks, so requests fit between the chunks instead of queueing behind one 98 s walk.
   * 0-byte "no such chunk" markers go first - an older build left a file behind for every hole, and
   * absence now comes from the region header, so they buy nothing - then the oldest payloads.
   *
   * Public, and never called from inside a request. Bounded: at most SWEEP_CAP files are examined or
   * deleted per sweep, and the log says so when there is more, pointing at the offline tool.
   */
  async sweepCacheBudget() {
    if (this._sweep) return this._sweep;
    if (!this.cacheDir || !this.cacheMaxBytes) return null;
    const root = path.join(this.cacheDir, this.worldTag, String(this.tableTag), this.lightTag);
    this._sweep = (async () => {
      const t0 = Date.now();
      const paths = [];
      const stack = [root];
      while (stack.length) {
        const d = stack.pop();
        let ent;
        try { ent = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ent) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p); else paths.push(p);
          if (paths.length >= SWEEP_CAP) break;
        }
        await null;                       // hand the loop back between directories
      }
      const files = [];
      for (let i = 0; i < paths.length; i += 2000) {
        const got = await Promise.all(paths.slice(i, i + 2000).map(async (p) => {
          try { const st = await fs.promises.stat(p); return [p, st.mtimeMs, st.size]; } catch { return null; }
        }));
        for (const f of got) if (f) files.push(f);
        this.stats.sweepFiles = files.length;
      }
      let total = 0;
      for (const [, , sz] of files) total += sz;
      this.baseBytes = total;
      this.stats.cacheBytes = total + this.writtenBytes;

      // Markers first (they cost an inode and free no bytes), then oldest payload first.
      files.sort((a, b) => ((a[2] === 0 ? 0 : 1) - (b[2] === 0 ? 0 : 1)) || a[1] - b[1]);
      const budget = this.cacheMaxBytes * 0.9;
      let freed = 0, gone = 0, markers = 0, capped = false;
      for (const [p, , sz] of files) {
        if (sz > 0 && total - freed <= budget) break;
        if (gone >= SWEEP_CAP) { capped = true; break; }
        try { await fs.promises.rm(p, { force: true }); } catch { continue; }
        freed += sz; gone++;
        if (sz === 0) markers++;
        if (gone % 250 === 0) await null;
      }
      this.stats.cachePruned += gone;
      this.baseBytes = total - freed;
      this.stats.cacheBytes = this.baseBytes + this.writtenBytes;
      this.stats.sweeps++;
      this.stats.sweepMs = Date.now() - t0;
      const ms = this.stats.sweepMs;
      console.log(`  cache: reconciled ${files.length} files (${(total / 1e9).toFixed(2)} GB) in ${ms} ms `
        + `without blocking: dropped ${markers} empty markers and ${gone - markers} payloads `
        + `(${(freed / 1e6).toFixed(1)} MB freed)` + (capped ? `, capped at ${SWEEP_CAP} - run `
          + 'tools/cache-prune.mjs for the rest' : ''));
      return { files: files.length, bytes: total, dropped: gone, markers, ms, capped };
    })();
    this._sweep.finally(() => { this._sweep = null; });
    return this._sweep;
  }
}

const SHORT = { overworld: 'minecraft:overworld', nether: 'minecraft:the_nether', end: 'minecraft:the_end' };
const shortName = (dim) => SHORT[dim] ?? dim;

/** Frames are 4-byte aligned: chunk payloads are read through typed-array views, and a view needs
 *  its byte offset to be a multiple of its element size. Empty frames mean "no such chunk". */
/**
 * The container a batch response is made of. `tableHash` is the state table these frames' global ids
 * were numbered against (0 = no claim, which only a hand-built batch should do): it costs 4 bytes and
 * it is what lets a page refuse an answer that belongs to another save.
 */
export function packBatch(frames, tableHash = 0) {
  let total = BATCH_HEADER;
  for (const b of frames) total += 4 + ((b.length + 3) & ~3);
  const out = Buffer.alloc(total);
  let p = 0;
  out.write(BATCH_MAGIC, p, 'ascii'); p += 8;
  out.writeUInt32LE(tableHash >>> 0, p); p += 4;
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
