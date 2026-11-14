// The browser's side of the baked coarse LOD layer: fetch region tiles of pre-made far geometry from
// worldd's /lod, decode them, hold them, and hand them to the renderer.
//
// This is the whole world below a few blocks per column, made once on the server (server/bake-lod.mjs)
// instead of on every pan and zoom in the browser. A tile is one region - the same 32x32 chunk
// granularity as the shell packs - so a whole dimension is a few hundred files at the coarse rung and
// a few thousand at the fine one: the overworld is 2.4 M verts at 16 blocks per column and 32 M at 4,
// which is still less geometry than a radius-16 detail ring of voxels.
//
// A position can be baked at several rungs, and the right rung depends on how far the camera is, so a
// tile is keyed by (cell, rx, rz) and `request` asks the caller which rung it wants per tile
// (shared/lod-format.mjs `pickLodCell`). At most one rung is held per position: two tiles painting the
// same ground is z-fighting, and the finer one is the truth.
//
// Deliberately DOM-free and three-free so a Node test can exercise the real fetch/decode/hold path.
import { openLodTile, policyMismatch, LOD_CELL, lodCellDir } from '../../shared/lod-format.mjs';
import { withWorld } from './world-param.js';

const key = (cell, rx, rz) => `${cell},${rx},${rz}`;
const posKey = (rx, rz) => `${rx},${rz}`;
// A remembered 404 must not be forever: `npm run bake:lod` can finish while a viewer is open.
const MISS_MS = 30000;

export class LodStore {
  /**
   * @param {string} dim dimension id
   * @param {{policy?: object, max?: number, concurrency?: number, url?: (cell:number,rx:number,rz:number)=>string,
   *          fetchFn?: Function, log?: (m:string)=>void}} [opts]
   *   policy: the far-paint settings the viewer is using. A tile baked under a different policy paints
   *   a different world, so it is refused (and `this.mismatch` says which field disagreed) rather than
   *   quietly shown.
   */
  constructor(dim, opts = {}) {
    this.dim = dim;
    this.policy = opts.policy ?? null;
    this.max = opts.max ?? 512;                    // tiles held (the overworld is 327 coarse, 3 298 fine)
    this.concurrency = opts.concurrency ?? 6;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.log = opts.log ?? (() => {});
    this.tiles = new Map();                       // "cell,rx,rz" -> tile image
    this.missing = new Map();                     // "cell,rx,rz" -> when it last looked absent
    this.wanted = new Set();                      // "cell,rx,rz" inside the requested rect
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
    this.index = null;                            // region slots that have tiles, or null = probe the range
    this.indexList = [];                          // [{cell,rx,rz}] in the same order, for a cheap scan
    this.cost = new Map();                        // "cell,rx,rz" -> that tile's vertex count, from the index
    this.cells = [];                              // rungs this dimension has, finest first
    this.at = new Map();                          // "rx,rz" -> the rungs held there, finest first
    this.posCells = new Map();                    // "rx,rz" -> the rungs the server has there
    this.reqBlind = 0;                            // requests made before the index was known
    this.fails = new Map();                       // "cell,rx,rz" -> consecutive failures
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
      this.#unpin(t.cell, t.rx, t.rz);
      this.mismatch = bad.field;
      this.badTiles++;
      n++;
    }
    return n;
  }

  /**
   * Which regions have tiles, and at which rung. The server knows; a save's bounding box is mostly
   * empty - the overworld spans 1 734 region slots but only 327 of them hold ground.
   *
   * @param {Array<Array<number>>|null} list [cell,rx,rz] triples, or [rx,rz] for a single-rung server
   */
  setIndex(list) {
    this.index = null;
    this.indexList = [];
    this.cost.clear();
    this.cells = [];
    this.at.clear();
    this.posCells.clear();
    if (!list) { this.missing.clear(); this.wanted.clear(); return; }
    const seen = new Set();
    for (const e of list) {
      const [cell, rx, rz, verts] = e.length >= 3 ? e : [LOD_CELL, e[0], e[1]];
      this.indexList.push({ cell, rx, rz });
      if (verts > 0) this.cost.set(key(cell, rx, rz), verts);   // the served index carries each tile's own cost
      seen.add(key(cell, rx, rz));
      const pk = posKey(rx, rz);
      const rung = this.posCells.get(pk) ?? [];
      if (!rung.includes(cell)) rung.push(cell);
      this.posCells.set(pk, rung);
      if (!this.cells.includes(cell)) this.cells.push(cell);
    }
    for (const rung of this.posCells.values()) rung.sort((a, b) => a - b);
    this.cells.sort((a, b) => a - b);              // finest rung first
    this.index = seen;
    this.missing.clear();
    this.wanted.clear();
  }

  /** Drop every "no tile here". A refusal recorded under the previous far paint must not sit there
   *  for 30 s after the viewer moves its settings back to the one the tiles were baked with. */
  forgetMissing() { this.missing.clear(); }

  /** Which rungs exist for one region slot. */
  cellsAt(rx, rz) { return this.posCells.get(posKey(rx, rz)) ?? []; }

  /**
   * What fetching and drawing this tile costs, in vertices, straight from the index the server built
   * off the baked files. The viewer budgets this layer per tile; if the only number it had was the
   * mean cost of the tiles it currently holds, then the decision changed the ruler it measured with:
   * fine tiles arrive -> the mean rises -> the budget line moves in -> those tiles are released ->
   * the mean falls -> they are asked for again. That loop is a flash, not a policy.
   */
  costOf(cell, rx, rz) { return this.cost.get(key(cell, rx, rz)) ?? 0; }

  /** The rung held for one region slot, 0 if none. */
  heldCell(rx, rz) {
    const list = this.at.get(posKey(rx, rz));
    return list && list.length ? list[0] : 0;
  }

  has(rx, rz) { return this.at.has(posKey(rx, rz)); }
  hasKey(k) { return this.tiles.has(k); }
  get(rx, rz) {
    const list = this.at.get(posKey(rx, rz));
    for (const c of list ?? []) { const t = this.tiles.get(key(c, rx, rz)); if (t) return t; }
    return null;
  }
  key(rx, rz) {
    const c = this.heldCell(rx, rz);
    return c ? key(c, rx, rz) : null;
  }
  tileCount() { return this.tiles.size; }

  /** Where a rung's tiles live on the server, for the log line. */
  static cellDir(cell) { return lodCellDir(cell); }

  #pin(cell, rx, rz) {
    const k = posKey(rx, rz);
    const list = this.at.get(k) ?? [];
    if (!list.includes(cell)) { list.push(cell); list.sort((a, b) => a - b); this.at.set(k, list); }
  }

  #unpin(cell, rx, rz) {
    const k = posKey(rx, rz);
    const list = this.at.get(k);
    if (!list) return;
    const i = list.indexOf(cell);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.at.delete(k);
  }

  /**
   * Ask for the tiles in a region rectangle. Nearest-first, so the middle of the view fills first,
   * and the rung for each tile is whatever `pick` says - which is where the viewer's pixel target and
   * its vertex budget live. `pick` is called in nearest-first order for exactly that reason: a budget
   * spends itself on the tiles that matter first.
   *
   * @param {(rx:number,rz:number,heldCell:number,available:number[])=>number} [pick]
   *   cell to ask for, or 0 to leave that tile alone
   */
  request(rx0, rz0, w, h, near = null, pick = null) {
    this.wanted.clear();
    const cand = [];
    if (this.index) {
      for (const t of this.indexList) {
        if (t.rx < rx0 || t.rx >= rx0 + w || t.rz < rz0 || t.rz >= rz0 + h) continue;
        cand.push(t);
      }
    } else {
      for (let rz = rz0; rz < rz0 + h; rz++) for (let rx = rx0; rx < rx0 + w; rx++) cand.push({ rx, rz });
      this.reqBlind += cand.length;
    }
    // With no index there is nothing to ask for except the floor rung, and probing the fine rung for
    // every slot in the box is exactly the request storm the index exists to prevent.
    const probe = [LOD_CELL];
    if (near) {
      const [nx, nz] = near;
      cand.sort((a, b) => (Math.max(Math.abs(a.rx - nx), Math.abs(a.rz - nz))
        - Math.max(Math.abs(b.rx - nx), Math.abs(b.rz - nz))));
    }
    const list = [];
    for (const t of cand) {
      const avail = this.index ? this.cellsAt(t.rx, t.rz) : probe;
      const held = this.heldCell(t.rx, t.rz);
      const cell = pick ? pick(t.rx, t.rz, held, avail) : (t.cell ?? avail[0]);
      if (!cell) continue;
      const k = key(cell, t.rx, t.rz);
      this.wanted.add(k);
      if (this.tiles.has(k) || this.inflight.has(k)) continue;
      const miss = this.missing.get(k);
      // The wait before asking again grows with the number of times this tile has failed. A tile
      // that is simply absent costs one request per window; a tile whose endpoint is broken costs
      // almost nothing, which is what keeps a viewer from grinding the server to a halt.
      const fails = this.fails.get(k) ?? 0;
      if (miss !== undefined && Date.now() - miss < MISS_MS * (1 + 20 * Math.max(0, fails - 1))) continue;
      list.push([cell, t.rx, t.rz]);
    }
    for (const e of list) this.queue.push(e);
    this.pump();
    return list.length;
  }

  url(cell, rx, rz) {
    return withWorld(`/lod?dim=${encodeURIComponent(this.dim)}&cell=${cell}&rx=${rx}&rz=${rz}`);
  }

  pump() {
    while (this.inflight.size < this.concurrency && this.queue.length) {
      const [cell, rx, rz] = this.queue.shift();
      const k = key(cell, rx, rz);
      if (this.tiles.has(k) || this.inflight.has(k)) continue;
      this.inflight.add(k);
      this.fetchFn(this.url(cell, rx, rz))
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
          // One rung per position. A finer tile arriving retires the coarser one it sits on top of -
          // both paint the same ground, so keeping both is z-fighting plus a double vertex bill.
          for (const c of this.at.get(posKey(t.rx, t.rz)) ?? []) {
            if (c === t.cell) continue;
            this.tiles.delete(key(c, t.rx, t.rz));
            this.#unpin(c, t.rx, t.rz);
            this.dropped++;
          }
          this.tiles.set(k, t);
          this.#pin(t.cell, t.rx, t.rz);
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
      // FIFO, not LRU: a coarse tile is 450 KB of vertices but only ~18 KB of file, and re-fetching
      // it is a disk read on the other side of a localhost socket. The bookkeeping of an LRU is not
      // worth it. The fine rung is 20x the bytes, so the cap is what keeps a long session bounded.
      const k = this.tiles.keys().next().value;
      if (this.wanted.has(k)) break;              // never evict something the current view asked for
      const [cell, rx, rz] = k.split(',').map(Number);
      this.tiles.delete(k);
      this.#unpin(cell, rx, rz);
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
    this.at.clear();
    this.queue.length = 0;
    this.inflight.clear();
  }

  /** Forget the index too - a dimension switch builds a whole new one. */
  forgetIndex() {
    this.index = null;
    this.indexList = [];
    this.cells = [];
    this.posCells.clear();
  }
}

export { LOD_CELL, lodCellDir };
