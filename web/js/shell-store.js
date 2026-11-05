// Heightmap shell streaming (M5), DOM-free like ChunkStore.
//
// Shells answer a different question from chunks: "what does the world look like 400 chunks from
// here". At ~1 KB per chunk the browser can hold the whole 34x50 region grid of this save as
// silhouette, which is impossible with ~100 KB payloads.
import { openShellBatch } from './payload.js';

const key = (cx, cz) => `${cx},${cz}`;

export class ShellStore {
  /**
   * @param {string} dim
   * @param {object} [opts]
   *   tile      chunks per batch edge (shells are small, so tiles are bigger than for voxels)
   *   keep      extra radius kept around the request before evicting
   *   held      (cx,cz) => true where full voxel detail already exists, so no shell is needed
   */
  constructor(dim, opts = {}) {
    this.dim = dim;
    this.tile = opts.tile ?? 16;
    this.keep = opts.keep ?? 6;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.held = opts.held ?? null;
    this.shells = new Map();
    this.missing = new Set();
    this.pending = new Set();
    this.queued = new Set();          // tile ids waiting in `queue`, so a per-frame request() cannot stack duplicates
    this.queue = [];
    this.busy = 0;
    this.dirty = new Set();
    this.radius = 0;
    this.center = null;
    this.listeners = [];
  }

  onChange(fn) { this.listeners.push(fn); }
  #notify() { for (const f of this.listeners) f(this); }

  #touch(cx, cz) {
    this.dirty.add(key(cx, cz));
    // a wall's height comes from the neighbour column, so a new shell changes its four neighbours
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.dirty.add(key(cx + dx, cz + dz));
  }

  /**
   * Ask for the shells in a square of half-size `radius` around (cx,cz), skipping the inner
   * square (|dx|,|dz| <= inner) that the detail chunks already cover.
   */
  request(cx, cz, radius, inner = 0) {
    this.center = [cx, cz];
    this.radius = radius;
    const x0 = cx - radius, x1 = cx + radius, z0 = cz - radius, z1 = cz + radius;
    const want = [];
    for (let ty = z0; ty <= z1; ty += this.tile) {
      for (let tx = x0; tx <= x1; tx += this.tile) {
        const w = Math.min(this.tile, x1 - tx + 1);
        const h = Math.min(this.tile, z1 - ty + 1);
        const id = `${tx},${ty},${w},${h}`;
        if (this.pending.has(id) || this.queued.has(id)) continue;
        let need = 0;
        for (let dz = 0; dz < h; dz++) {
          for (let dx = 0; dx < w; dx++) {
            const gx = tx + dx, gz = ty + dz;
            if (Math.abs(gx - cx) <= inner && Math.abs(gz - cz) <= inner) continue;
            const k = key(gx, gz);
            if (!this.shells.has(k) && !this.missing.has(k) && !(this.held && this.held(gx, gz))) need++;
          }
        }
        if (!need) continue;
        // Nearest tile first. A full-extent skin is ~37 000 chunks no matter what the server does,
        // so the order is what decides whether the middle of the frame is filled in half a second
        // or the corners are: row-major starts at the top-left corner of the square.
        const d = Math.max(Math.abs(tx + w / 2 - cx), Math.abs(ty + h / 2 - cz));
        want.push({ tx, ty, w, h, d, id });
      }
    }
    want.sort((a, b) => a.d - b.d);
    for (const t of want) { this.queued.add(t.id); this.queue.push(t); }
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
      const url = `/shells?dim=${encodeURIComponent(this.dim)}&cx0=${t.tx}&cz0=${t.ty}&w=${t.w}&h=${t.h}`;
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
    try { frames = openShellBatch(ab); } catch (e) { console.error('shell batch parse failed', e); return; }
    let added = 0;
    for (const s of frames) {
      if (!s) continue;
      const k = key(s.cx, s.cz);
      this.missing.delete(k);
      if (this.shells.has(k)) continue;
      this.shells.set(k, s);
      this.#touch(s.cx, s.cz);
      added++;
    }
    for (let dz = 0; dz < t.h; dz++) {
      for (let dx = 0; dx < t.w; dx++) {
        const k = key(t.tx + dx, t.ty + dz);
        if (!this.shells.has(k)) this.missing.add(k);
      }
    }
    if (this.center) this.#evict();
    if (added) this.#notify();
  }

  #evict() {
    const [cx, cz] = this.center;
    const limit = this.radius + this.keep;
    for (const k of [...this.shells.keys()]) {
      const s = this.shells.get(k);
      if (Math.abs(s.cx - cx) > limit || Math.abs(s.cz - cz) > limit) {
        this.shells.delete(k);
        this.#touch(s.cx, s.cz);
      }
    }
    // Confirmed holes have to expire too, or the count keeps every hole the camera ever flew past
    // and the HUD stops describing the view it is showing.
    for (const k of [...this.missing]) {
      const [mx, mz] = k.split(',').map(Number);
      if (Math.abs(mx - cx) > limit || Math.abs(mz - cz) > limit) this.missing.delete(k);
    }
  }

  has(cx, cz) { return this.shells.has(key(cx, cz)); }
  get(cx, cz) { return this.shells.get(key(cx, cz)); }

  /** Dirty chunk keys, drained. The renderer turns these into patch keys to rebuild. */
  takeDirty(limit = Infinity) {
    const out = [];
    for (const k of this.dirty) {
      out.push(k);
      this.dirty.delete(k);
      if (out.length >= limit) break;
    }
    return out;
  }

  get loaded() { return this.shells.size; }
  get inflight() { return this.busy; }
}
