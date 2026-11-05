// The browser's side of the baked coarse LOD layer: fetch region tiles of pre-made far geometry from
// worldd's /lod, decode them, hold them, and hand them to the renderer.
//
// This is the whole world below 16 blocks per column, made once on the server (server/bake-lod.mjs)
// instead of on every pan and zoom in the browser. A tile is one region - the same 32x32 chunk
// granularity as the shell packs - so a whole dimension is a few hundred files and a few million
// vertices: the overworld is 2.5 M verts for its 512 km^2 of saved ground, which is less geometry
// than one radius-8 detail ring of voxels.
//
// Deliberately DOM-free and three-free so a Node test can exercise the real fetch/decode/hold path.
import { openLodTile, policyMismatch, LOD_CELL } from '../../shared/lod-format.mjs';

const key = (rx, rz) => `${rx},${rz}`;
// A remembered 404 must not be forever: `npm run bake:lod` can finish while a viewer is open.
const MISS_MS = 30000;

export class LodStore {
  /**
   * @param {string} dim dimension id
   * @param {{policy?: object, max?: number, concurrency?: number, url?: (rx:number,rz:number)=>string,
   *          fetchFn?: Function, log?: (m:string)=>void}} [opts]
   *   policy: the far-paint settings the viewer is using. A tile baked under a different policy paints
   *   a different world, so it is refused (and `this.mismatch` says which field disagreed) rather than
   *   quietly shown.
   */
  constructor(dim, opts = {}) {
    this.dim = dim;
    this.policy = opts.policy ?? null;
    this.max = opts.max ?? 512;                    // tiles held (the overworld is 327)
    this.concurrency = opts.concurrency ?? 6;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.log = opts.log ?? (() => {});
    this.tiles = new Map();                       // "rx,rz" -> tile image
    this.missing = new Map();                     // "rx,rz" -> when it last looked absent
    this.wanted = new Set();                      // "rx,rz" inside the requested rect
    this.queue = [];
    this.inflight = new Set();
    this.listeners = [];
    this.loaded = 0;
    this.dropped = 0;
    this.mismatch = null;                         // the geometry field a tile disagreed with
    this.shadeDiff = null;                        // a shading field the tiles were baked with other
    // than ours: reported, not fatal - the tiles still draw, because a differently shaded coarse
    // plain beats an unpainted horizon.
    this.badTiles = 0;                            // tiles refused (bad stamp/policy/truncated)
    this.index = null;                            // regions that have tiles, or null = probe the range
    this.reqBlind = 0;                            // requests made before the index was known
    this.fails = new Map();                       // "rx,rz" -> consecutive failures
  }

  onChange(fn) { this.listeners.push(fn); }
  notify() { for (const fn of this.listeners) fn(); }

  /**
   * Re-apply the current policy to everything held. Called when the viewer's far paint changes.
   * A tile baked with different *terrain* comes out, because it would stand where the live view
   * paints something else. A tile baked with a different *shading curve* stays: it is the same
   * ground with slightly different vertex colours, and dropping it leaves the distance unpainted.
   *
   * @returns {number} how many tiles were dropped
   */
  recheck() {
    if (!this.policy) return 0;
    let n = 0;
    this.shadeDiff = null;
    for (const [k, t] of [...this.tiles]) {
      const bad = policyMismatch(t, this.policy);
      if (!bad) continue;
      if (bad.kind === 'shade') { this.shadeDiff = bad.field; continue; }
      this.tiles.delete(k);
      this.mismatch = bad.field;
      this.badTiles++;
      n++;
    }
    return n;
  }

  /** Which regions have tiles. The server knows; a save's bounding box is mostly empty - the
   *  overworld spans 1 734 region slots but only 327 of them hold ground. */
  setIndex(list) {
    this.index = !list ? null : new Set(list.map(([x, z]) => key(x, z)));
    this.missing.clear();
    this.wanted.clear();
  }

  /** Drop every "no tile here". A refusal recorded under the previous far paint must not sit there
   *  for 30 s after the viewer moves its settings back to the one the tiles were baked with. */
  forgetMissing() { this.missing.clear(); }

  has(rx, rz) { return this.tiles.has(key(rx, rz)); }
  get(rx, rz) { return this.tiles.get(key(rx, rz)) ?? null; }
  tileCount() { return this.tiles.size; }

  /** Ask for every tile in a region rectangle. Nearest-first, so the middle of the view fills first. */
  request(rx0, rz0, w, h, near = null) {
    this.wanted.clear();
    const list = [];
    for (let rz = rz0; rz < rz0 + h; rz++) {
      for (let rx = rx0; rx < rx0 + w; rx++) {
        const k = key(rx, rz);
        if (this.index && !this.index.has(k)) continue;
        this.wanted.add(k);
        if (this.tiles.has(k) || this.inflight.has(k)) continue;
        const miss = this.missing.get(k);
        // The wait before asking again grows with the number of times this tile has failed. A tile
        // that is simply absent costs one request per window; a tile whose endpoint is broken costs
        // almost nothing, which is what keeps a viewer from grinding the server to a halt.
        const fails = this.fails.get(k) ?? 0;
        if (miss !== undefined && Date.now() - miss < MISS_MS * (1 + 20 * Math.max(0, fails - 1))) continue;
        list.push([rx, rz]);
      }
    }
    if (!this.index) this.reqBlind += list.length;
    if (near) {
      const [nx, nz] = near;
      list.sort((a, b) => (Math.max(Math.abs(a[0] - nx), Math.abs(a[1] - nz))
        - Math.max(Math.abs(b[0] - nx), Math.abs(b[1] - nz))));
    }
    for (const [rx, rz] of list) this.queue.push([rx, rz]);
    this.pump();
    return list.length;
  }

  url(rx, rz) {
    return `/lod?dim=${encodeURIComponent(this.dim)}&rx=${rx}&rz=${rz}`;
  }

  pump() {
    while (this.inflight.size < this.concurrency && this.queue.length) {
      const [rx, rz] = this.queue.shift();
      const k = key(rx, rz);
      if (this.tiles.has(k) || this.inflight.has(k)) continue;
      this.inflight.add(k);
      this.fetchFn(this.url(rx, rz))
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((buf) => {
          this.inflight.delete(k);
          if (!buf) {
            // Bookkeeping first, then refill the pipeline. Pumping before the miss is recorded lets
            // pump() re-queue this very key: 404 -> pump -> 404, a request loop that takes the server
            // down. It did.
            this.#fail(k);
            this.notify();
            this.pump();
            return;
          }
          let t;
          try {
            t = openLodTile(buf);
          } catch (e) {
            this.badTiles++;
            this.missing.set(k, Date.now());
            this.log(`lod tile ${k} refused: ${e.message}`);
            this.notify();
            this.pump();
            return;
          }
          const bad = this.policy ? policyMismatch(t, this.policy) : null;
          if (bad && bad.kind === 'geom') {
            this.mismatch = bad.field;
            this.badTiles++;
            this.missing.set(k, Date.now());
            this.log(`lod tile ${k} baked with different terrain (${bad.field})`);
            this.notify();
            this.pump();
            return;
          }
          if (bad) this.shadeDiff = bad.field;   // same ground, other shading curve: draw it, say so
          this.mismatch = null;             // a tile that agrees means the layer works again
          this.missing.delete(k);
          this.fails.delete(k);
          this.tiles.set(k, t);
          this.loaded++;
          this.#evict();
          this.notify();
          this.pump();
        })
        .catch((e) => {
          this.inflight.delete(k);
          this.#fail(k);
          this.log(`lod tile ${k} failed: ${e && e.message}`);
          this.notify();
          this.pump();
        });
    }
  }

  /** One failed fetch marks a tile absent for MISS_MS. Repeating it means something is wrong with
   *  the endpoint, and hammering it is how a viewer kills the server, so after a few tries the tile
   *  is parked for much longer than the normal expiry. */
  #fail(k) {
    this.fails.set(k, (this.fails.get(k) ?? 0) + 1);
    this.missing.set(k, Date.now());
  }

  #evict() {
    while (this.tiles.size > this.max) {
      // FIFO, not LRU: a tile is 450 KB of vertices but only ~18 KB of file, and re-fetching it is a
      // disk read on the other side of a localhost socket. The bookkeeping of an LRU is not worth it.
      const k = this.tiles.keys().next().value;
      if (this.wanted.has(k)) break;              // never evict something the current view asked for
      this.tiles.delete(k);
      this.dropped++;
    }
  }

  /** Tiles the view asked for but does not hold (still in flight, missing, or refused). */
  gaps() {
    let n = 0;
    for (const k of this.wanted) if (!this.tiles.has(k)) n++;
    return n;
  }

  clear() {
    this.tiles.clear();
    this.missing.clear();
    this.wanted.clear();
    this.queue.length = 0;
    this.inflight.clear();
  }
}

export { LOD_CELL };
