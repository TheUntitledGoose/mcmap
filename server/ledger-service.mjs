// M12: serving the block-history index. worldd answers three questions from it:
//   meta   - who is in the log, which dimensions have packs, and what the row numbers cover
//   cells  - the sparse per-chunk activity table an overlay paints
//   rows   - what happened at one chunk, for the click-a-block card
// Nothing here scans 424,599 rows per request: the packs are memory-mapped once, and the log itself is
// loaded lazily because only the row query needs its text.
import fs from 'node:fs';
import path from 'node:path';
import { CELL_BYTES, CELL_H_BYTES, LEDPACK_HEADER, readPack } from '../shared/ledger-pack.mjs';
import { readLedger } from '../shared/ledger-format.mjs';

export class LedgerService {
  constructor(dir = 'build/ledger') {
    this.dir = dir;
    this.metaPath = path.join(dir, 'meta.json');
    this.meta = null;
    this.packs = new Map();          // dim key -> readPack view (cached; packs are bake-time artifacts)
    this.raws = new Map();           // dim key -> the pack bytes the view was read from
    this.log = null;                 // the exported log, loaded only when a row query asks
    this.stats = { cellsServed: 0, rowQueries: 0, logLoads: 0, packOpens: 0 };
  }

  get ready() { return fs.existsSync(this.metaPath); }

  loadMeta() {
    if (this.meta) return this.meta;
    if (!this.ready) return null;
    this.meta = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    this.byDim = new Map();
    for (const d of this.meta.dims) {
      this.byDim.set(d.dimKey, d);
      this.byDim.set(d.dimId, d);
    }
    return this.meta;
  }

  /** Accepts either our dim folder key or the dimension identifier, same as the other endpoints. */
  dimInfo(dim) {
    this.loadMeta();
    return this.byDim?.get(dim) ?? null;
  }

  packFor(dim) {
    const info = this.dimInfo(dim);
    if (!info) return null;
    let p = this.packs.get(info.dimKey);
    if (p) return p;
    const file = path.join(this.dir, info.pack);
    if (!fs.existsSync(file)) return null;
    // A pack holds indices into the exported log, so it is only valid while that export is the one it
    // was baked from. Mtime is the cheap, honest check: re-export without re-baking and the index is
    // refused rather than answering with someone else's rows.
    const packMtime = fs.statSync(file).mtimeMs;
    if (this.meta.source?.mtimeMs && packMtime < this.meta.source.mtimeMs) {
      this.stats.stale = info.dimKey;
      return null;
    }
    this.stats.stale = null;
    const raw = fs.readFileSync(file);
    try {
      p = readPack(raw);
    } catch (e) {
      // A pack from an older bake is a file this server cannot read, and a thrown reader would turn a
      // browser overlay request into a 500 with no hint. Refuse it, and name why in the stats the
      // meta endpoint already ships, so the answer is "re-bake" rather than a stack trace.
      this.stats.badPack = { dimKey: info.dimKey, why: String(e?.message ?? e) };
      return null;
    }
    this.packs.set(info.dimKey, p);
    this.raws.set(info.dimKey, raw);
    this.stats.packOpens++;
    return p;
  }

  metaJson() {
    const m = this.loadMeta();
    if (!m) return { available: false, why: `run: python tools/ledger-export.py && node server/bake-ledger.mjs` };
    return {
      available: true,
      ...m,
      logLoaded: !!this.log,
      logBytes: this.meta.source.bytes,
      stats: this.stats,
    };
  }

  /**
   * The cell table alone: the pack header rewritten with the two later sections declared empty, so a
   * browser gets 32 B + 2 B per touched chunk instead of the 2.3 MB pack and needs no second reader.
   * The 2 B height plane travels with it because it is what the overlay stands on (see the format note).
   */
  cellsBytes(dim) {
    const p = this.packFor(dim);
    if (!p) return null;
    const raw = this.raws.get(p.dimKey);
    const head = LEDPACK_HEADER + Buffer.byteLength(p.dimKey, 'utf8');
    const bytes = head + p.cellCount * (CELL_BYTES + CELL_H_BYTES);
    const out = Buffer.alloc(bytes);
    raw.copy(out, 0, 0, bytes);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(24, 0, true);      // chunkCount: not shipped, the overlay does not use it
    dv.setUint32(28, 0, true);      // rowCount
    dv.setUint32(40, 0, true);      // tlCount: the timeline is /ledger/timeline, not this response
    this.stats.cellsServed++;
    return out;
  }

  /**
   * The playhead data: this dimension's rows in time order, each carrying its block position.
   *
   * A separate endpoint because of the size asymmetry. The cells slice the heat layer needs is 691 KB
   * for 20,322 chunks; this is 4.9 MB for the same dimension's 351,531 rows. Time travel should cost
   * that 4.9 MB, and an ordinary map view should not.
   */
  timelineBytes(dim) {
    const p = this.packFor(dim);
    if (!p || !p.tlBytes) return null;
    const [a, b] = p.tlBytes;
    this.stats.timelinesServed = (this.stats.timelinesServed ?? 0) + 1;
    return this.raws.get(p.dimKey).subarray(a, b);
  }

  loadLog() {
    if (this.log) return this.log;
    if (!this.meta?.source?.path || !fs.existsSync(this.meta.source.path)) return null;
    this.log = readLedger(fs.readFileSync(this.meta.source.path));
    this.stats.logLoads++;
    return this.log;
  }

  /**
   * Rows for one chunk, oldest first, optionally narrowed to one action class or one player.
   * `limit` protects a click on a chunk with 4,254 rows from shipping all of them.
   */
  rowsAt(dim, cx, cz, { limit = 120, cls = 0, player = 0 } = {}) {
    const p = this.packFor(dim);
    if (!p) return null;
    const hit = p.findChunk(cx, cz);
    if (!hit) return { rows: [], total: 0, truncated: false };
    const L = this.loadLog();
    if (!L) return { rows: [], total: hit.rowCount, truncated: false, why: 'log export missing' };
    const out = [];
    for (let k = 0; k < hit.rowCount && out.length < limit; k++) {
      const i = p.rowIdx(hit.rowStart + k);
      const aid = L.actionId(i);
      if (cls && aid !== cls) continue;
      const pid = L.playerId(i);
      if (player && pid !== player) continue;
      const obj = L.objects.get(L.objectId(i))?.id ?? '';
      const old = L.objects.get(L.oldObjectId(i))?.id ?? '';
      out.push({
        row: L.rowid(i),
        t: L.timeMs(i),
        x: L.x(i), y: L.y(i), z: L.z(i),
        cls: aid,
        block: aid === 3 ? old : obj,     // a break names the block that left
        now: obj,                        // what the log says is there afterwards
        was: old,
        player: pid ? (this.meta.players.find((x) => x.id === pid)?.name ?? `#${pid}`) : '',
        source: L.sources.get(L.sourceId(i))?.id ?? '',
        props: L.blockStrId(i) ? L.strings[L.blockStrId(i)] : '',
        extra: L.extraStrId(i) ? L.strings[L.extraStrId(i)] : '',
      });
    }
    this.stats.rowQueries++;
    return { rows: out, total: hit.rowCount, truncated: out.length >= limit && hit.rowCount > out.length };
  }

  /**
   * Where the action is: cells sorted by count for one class/player. This is the "can I find it"
   * query - a few tens of thousands of cells is a cheap sort, and the answer is what a viewer wants
   * to fly to.
   */
  topCells(dim, { cls = 0, player = 0, limit = 40, near = null } = {}) {
    const p = this.packFor(dim);
    if (!p) return null;
    const out = [];
    for (let c = 0; c < p.cellCount; c++) {
      const e = p.cell(c);
      if (player && !(e.playerMask & (1 << (player - 1)))) continue;
      const n = cls ? e.counts[cls - 1] : e.total;
      if (!n) continue;
      if (near) {
        const dx = e.cx - near.cx, dz = e.cz - near.cz;
        if (Math.abs(dx) > near.r || Math.abs(dz) > near.r) continue;
      }
      out.push({ cx: e.cx, cz: e.cz, n, counts: e.counts, mask: e.playerMask,
        t0: (p.timeBaseSec + e.firstSec) * 1000, t1: (p.timeBaseSec + e.lastSec) * 1000 });
    }
    out.sort((a, b) => b.n - a.n);
    return { total: out.length, cells: out.slice(0, limit), timeBaseSec: p.timeBaseSec };
  }
}
