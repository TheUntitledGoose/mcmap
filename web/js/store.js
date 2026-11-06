// Chunk streaming + neighbour access, DOM-free (fetch only) so it can be driven from tests.
//
// The browser keeps voxel truth, not triangles: a chunk stays in the store as its decoded
// payload, and meshes are derived from it. That is what makes x-ray / filter / log-overlay
// features possible later without re-fetching the world.
import { openBatch } from './payload.js';
import { combineLight, lightLevels } from '../../shared/light.mjs';

const key = (cx, cz) => `${cx},${cz}`;

// Rough, honest, and cheap: the typed arrays a decoded payload owns are what actually sits in
// memory, and the voxel arrays dominate it. The batch ArrayBuffer is shared between the chunks of
// one tile, so this slightly under-counts; the number exists to answer "did keeping payloads warm
// eat the page", not to be a profiler.
const chunkBytes = (c) => 2 * (c.palette.length
  + (c.height ? c.height.length : 0) + (c.heightMotion ? c.heightMotion.length : 0)
  + c.sections.reduce((a, s) => a + (s.vox ? s.vox.length : 1), 0));

export class ChunkStore {
  /**
   * @param {string} dim      dimension id as worldd reports it (or its short alias)
   * @param {object} [opts]
   */
  constructor(dim, opts = {}) {
    this.dim = dim;
    this.tile = opts.tile ?? 6;            // chunks per batch edge
    this.maxChunks = opts.maxChunks ?? 400;
    // Eviction radius in chunks, explicit. Deriving it from maxChunks meant the *mesh* radius and
    // the *payload* radius were the same number: demoting a far chunk (drop its geometry, keep its
    // voxels so coming back costs a re-mesh and not a re-fetch) was impossible, because keeping the
    // payload wider than the ring also pushed the eviction limit out with it.
    this.evictLimit = opts.evictLimit ?? null;
    this.bytesHeld = 0;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.chunks = new Map();
    this.pending = new Set();
    this.queued = new Set();
    this.busy = 0;
    this.queue = [];
    this.dirty = new Set();
    // Who marked a chunk dirty, for the page's benefit. A dirty mark is a mesh job waiting to happen
    // (tens of ms), so "why is this chunk being meshed again" has to be answerable: an arrival marks
    // four neighbours, an eviction marks five, a cost-adaptive ring marks a whole band, and only one
    // of those three is work that actually changes the triangles.
    this.onDirty = opts.onDirty ?? null;
    this.center = null;
    this.missing = new Set();              // confirmed-empty coordinates, so we stop asking
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }
  #notify() { for (const f of this.listeners) f(this); }

  /**
   * Mark a chunk and its four neighbours for remeshing (neighbour presence changes culling).
   * Only held neighbours: a key for a chunk nobody has would sit in the set until that chunk
   * arrives, and a chunk that is later evicted would leave its neighbours' keys behind forever.
   */
  #touch(cx, cz, why = 'arrive') {
    const mark = (x, z) => {
      const k = key(x, z);
      if (!this.dirty.has(k)) { try { this.onDirty?.(k, why); } catch { /* diagnostics must not break loading */ } }
      this.dirty.add(k);
    };
    mark(cx, cz);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this.chunks.has(key(cx + dx, cz + dz))) mark(cx + dx, cz + dz);
    }
  }

  /**
   * Ask for the chunks needed to render a square of half-size `radius` (in chunks) around
   * (cx,cz). Queued tile fetches run with bounded concurrency.
   */
  request(cx, cz, radius) {
    this.center = [cx, cz];
    const x0 = cx - radius, x1 = cx + radius, z0 = cz - radius, z1 = cz + radius;
    const want = [];
    for (let ty = z0; ty <= z1; ty += this.tile) {
      for (let tx = x0; tx <= x1; tx += this.tile) {
        const w = Math.min(this.tile, x1 - tx + 1);
        const h = Math.min(this.tile, z1 - ty + 1);
        const id = `${tx},${ty},${w},${h}`;
        if (this.pending.has(id) || this.queued.has(id)) continue;
        // Only queue tiles that still have something to fetch. Without this, an idle renderer
        // calling request() every frame would re-download the whole neighbourhood forever -
        // and a camera parked over ungenerated chunks would hammer the same 404 holes.
        let need = 0;
        for (let dz = 0; dz < h; dz++) {
          for (let dx = 0; dx < w; dx++) {
            const k = key(tx + dx, ty + dz);
            if (!this.chunks.has(k) && !this.missing.has(k)) need++;
          }
        }
        if (need) want.push({ tx, ty, w, h, id, d: Math.max(Math.abs(tx + w / 2 - cx), Math.abs(ty + h / 2 - cz)) });
      }
    }
    // Nearest tile first. Raster order fills a big radius from its far corner, so the middle of the
    // view - the part being looked at - is the last thing to arrive.
    want.sort((a, b) => a.d - b.d);
    for (const t of want) { this.queue.push(t); this.queued.add(t.id); }
    this.#pump();
  }

  #pump() {
    while (this.busy < this.maxConcurrent && this.queue.length) {
      const t = this.queue.shift();
      const id = `${t.tx},${t.ty},${t.w},${t.h}`;
      this.queued.delete(id);
      if (this.pending.has(id)) continue;
      this.pending.add(id);
      this.busy++;
      const url = `/voxels?dim=${encodeURIComponent(this.dim)}&cx0=${t.tx}&cz0=${t.ty}&w=${t.w}&h=${t.h}`;
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((ab) => { if (ab) this.#ingest(t, ab); })
        .catch(() => {})
        .finally(() => {
          this.pending.delete(id);
          this.busy--;
          this.#pump();
          this.#notify();
        });
    }
  }

  #ingest(t, ab) {
    let frames;
    try { frames = openBatch(ab); } catch (e) { console.error('batch parse failed', e); return; }
    let added = 0;
    for (const c of frames) {
      if (!c) continue;                                  // empty frame: that chunk does not exist
      const k = key(c.cx, c.cz);
      this.missing.delete(k);
      if (this.chunks.has(k)) continue;
      this.chunks.set(k, c);
      this.bytesHeld += chunkBytes(c);
      this.#touch(c.cx, c.cz, 'arrive');
      added++;
    }
    // remember the holes so a stationary camera does not hammer the same empty tiles
    for (let dz = 0; dz < t.h; dz++) {
      for (let dx = 0; dx < t.w; dx++) {
        const k = key(t.tx + dx, t.ty + dz);
        if (!this.chunks.has(k)) this.missing.add(k);
      }
    }
    if (this.chunks.size > this.maxChunks) this.#evict();
    if (added) this.#notify();
  }

  #evict() {
    if (!this.center) return;
    const [cx, cz] = this.center;
    const limit = this.evictLimit ?? Math.ceil(Math.sqrt(this.maxChunks)) / 2 + 2;
    for (const k of [...this.chunks.keys()]) {
      const c = this.chunks.get(k);
      if (Math.abs(c.cx - cx) > limit || Math.abs(c.cz - cz) > limit) {
        this.chunks.delete(k);
        this.bytesHeld -= chunkBytes(c);
        this.#touch(c.cx, c.cz, 'evict');
      }
    }
    if (this.bytesHeld < 0) this.bytesHeld = 0;      // counters must never drift negative
  }

  has(cx, cz) { return this.chunks.has(key(cx, cz)); }
  get(cx, cz) { return this.chunks.get(key(cx, cz)); }

  /**
   * Atlas state index at a world-ish coordinate: chunk (cx,cz) plus local offsets that may
   * reach into a neighbour (lx,lz in -1..16). Returns -1 when unknown.
   * `stateOf(globalId)` maps payload ids to atlas indices (payload ids are atlas index + 1).
   */
  stateIndexAt(cx, cz, lx, ly, lz, stateOf) {
    const c = this.chunks.get(key(cx + (lx >> 4), cz + (lz >> 4)));
    if (!c) return -1;
    const s = c.sectionAt(ly);
    if (!s) return -1;
    const x = lx & 15, z = lz & 15;
    const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
    return stateOf(id);
  }

  /**
   * Combined sky+block light (0..15) at a coordinate that may sit in a neighbouring chunk, or -1
   * when nothing is loaded there. Mirrors `stateIndexAt` exactly: the mesher probes the same cell for
   * occlusion and for light, and if the two resolved the coordinate differently a face would be lit
   * by one chunk and hidden by another.
   */
  lightLevelAt(cx, cz, lx, ly, lz, skyScale = 1) {
    const c = this.chunks.get(key(cx + (lx >> 4), cz + (lz >> 4)));
    if (!c) return -1;
    const lv = lightLevels(c.sectionAt, lx, ly, lz);
    return lv ? combineLight(lv[0], lv[1], skyScale) : -1;
  }

  /** Skylight only, same coordinate rules as `lightLevelAt`: block light does not make a cavern visible. */
  skyLevelAt(cx, cz, lx, ly, lz) {
    const c = this.chunks.get(key(cx + (lx >> 4), cz + (lz >> 4)));
    if (!c) return -1;
    const lv = lightLevels(c.sectionAt, lx, ly, lz);
    return lv ? lv[0] : -1;
  }

  /**
   * Take up to `limit` keys that need re-meshing, **nearest to the last requested centre first**.
   * Insertion order is arrival order, which after a zoom-in (a couple of hundred chunks promoted at
   * once, one frame budget) fills the far side of the ring before the part being looked at.
   */
  takeDirty(limit = Infinity) {
    if (!(limit >= 0) || this.dirty.size <= limit || !this.center) {
      const out = [];
      for (const k of this.dirty) { out.push(k); this.dirty.delete(k); }
      return out;
    }
    const [cx, cz] = this.center;
    // One pass, one sort. This used to keep a small sorted array and re-sort it for every key it
    // considered, and the page asked for exactly one key at a time: with 1.4k dirty keys a frame took
    // ~50 of them and re-scanned the whole set 50 times (1.4k `split(',')` + two Number parses each).
    // That bookkeeping is what the drag's `mesh` bucket was spending 14 ms a frame on - not meshing.
    const near = [];
    for (const k of this.dirty) {
      const c = k.indexOf(',');
      const d = Math.max(Math.abs(+k.slice(0, c) - cx), Math.abs(+k.slice(c + 1) - cz));
      near.push([d, k]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (let i = 0; i < limit && i < near.length; i++) { out.push(near[i][1]); this.dirty.delete(near[i][1]); }
    return out;
  }

  get loaded() { return this.chunks.size; }
  get inflight() { return this.busy; }
}
