// M12: the data half of the block-history overlay - "who placed this, and can I find it".
//
// DOM-free and three-free on purpose, like the rest of web/js: the page owns the mesh and the card,
// and everything that decides *what the log is claiming* lives here where tests can ask it directly.
// The four things worth getting right are the filter, the heat scale, the geometry, and the wording
// of a row - the first three are numbers, the last one is what a person reads.
//
// What the browser is given (server/worldd.mjs -> /ledger/cells) is one record per chunk the log
// touches, with per-action counts, a player bit mask, a time span and a ground height: 20,322 records
// for the overworld out of 284,239 chunks that exist. Rows themselves are only fetched for one chunk
// at a time (/ledger/rows), because the log is 424,599 rows and 30 MB.

import { ACTION_NAME } from '../../shared/ledger-format.mjs';
import { NCLASS } from '../../shared/ledger-pack.mjs';
import { srgbToLinear } from './shell-mesh.js';

export const LEDGER_CLASSES = Array.from({ length: NCLASS }, (_, i) => ({
  id: i + 1, name: ACTION_NAME[i + 1],
}));

/** Which count column a class filter reads; 0 / anything unknown means "every kind of action". */
export const classColumn = (cls) => (cls >= 1 && cls <= NCLASS ? cls - 1 : -1);

/**
 * The player bit mask bit for a player id. Ids come from the ledger's own Players table and the bake
 * refuses more than 32 of them, so an id outside that range gets bit 0 - which matches no cell,
 * rather than silently matching every one.
 */
export const playerBit = (player) => (player >= 1 && player <= 32 ? 1 << (player - 1) : 0);

/**
 * How loud a chunk is, on a scale that can show a 4,254-row chunk and a 1-row chunk in one picture.
 * Linear would put 96 % of the touched chunks in the first shade of the ramp: the overworld's
 * median touched chunk has 3 rows and its busiest has 4,254 (build/dbg-ledger.mjs).
 */
export function heatScale(n, nMax) {
  if (!(n > 0)) return 0;
  const top = Math.log2(1 + Math.max(1, nMax));
  return top <= 0 ? 1 : Math.min(1, Math.log2(1 + n) / top);
}

// Teal through amber to hot red. Deliberately not a rainbow: this sits on top of a world that is
// already green, brown and blue, so the ramp has to be readable as "more" without being mistaken
// for terrain colour. Values are sRGB; heatLinear converts them the way three converts a texture.
export const HEAT_RAMP = [
  [0.05, 0.34, 0.44],
  [0.10, 0.64, 0.55],
  [0.95, 0.75, 0.22],
  [1.00, 0.33, 0.14],
];

/** Ramp position in sRGB, clamped at both ends. */
export function heatRamp(t) {
  const k = Math.max(0, Math.min(1, t)) * (HEAT_RAMP.length - 1);
  const i = Math.min(HEAT_RAMP.length - 2, Math.floor(k));
  const f = k - i;
  const a = HEAT_RAMP[i], b = HEAT_RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Ramp colour in the linear working space three.js composites in. */
export function heatLinear(n, nMax) {
  const [r, g, b] = heatRamp(heatScale(n, nMax));
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/**
 * Every chunk the log touched, narrowed to the filter the panel is showing.
 *
 * `cls` 0 keeps all six action kinds summed together, `player` 0 keeps sources that are not players
 * (fire, fluid, decay, explosions) as well, and `minN` drops the single-row specks a whole-world view
 * cannot resolve anyway. A cell with no baked ground height is reported separately: it is a fact about
 * the bake (no overview frame for that dimension), not an empty answer.
 */
export function collectCells(pack, { cls = 0, player = 0, minN = 1 } = {}) {
  const col = classColumn(cls);
  const bit = player > 0 ? playerBit(player) : 0;
  const cells = [];
  let max = 0, noHeight = 0, dropped = 0;
  for (let i = 0; i < pack.cellCount; i++) {
    const c = pack.cell(i);
    if (player > 0 && !(c.playerMask & bit)) continue;
    const n = col >= 0 ? c.counts[col] : c.total;
    if (n < minN) { if (n) dropped++; continue; }
    if (c.y === null) noHeight++;
    cells.push({
      cx: c.cx, cz: c.cz, n, y: c.y, mask: c.playerMask,
      t0: (pack.timeBaseSec + c.firstSec) * 1000,
      t1: (pack.timeBaseSec + c.lastSec) * 1000,
    });
    if (n > max) max = n;
  }
  return { cells, max, noHeight, dropped };
}

/** The "can I find it" answer: the chunks where that player did the most, loudest first. */
export function rankCells(cells, limit = 12) {
  return cells.slice().sort((a, b) => b.n - a.n || a.cx - b.cx || a.cz - b.cz).slice(0, limit);
}

/**
 * Flat quads on the ground, one per touched chunk, as soup-free indexed triangles: four corners and
 * six indices, the same layout the detail meshes use, so the vertex bill is the same shape.
 * Winding is chosen to face +Y; the material is double-sided anyway, because this overlay is read
 * from above and from the side, and in walk mode you are sometimes under it.
 */
export function buildHeatQuads(cells, { bias = 0.6, size = 16, inset = 0 } = {}) {
  // Past half the cell the tile would pass through its own centre and the winding would flip, which turns
  // an upward-facing overlay into a downward one - invisible under FrontSide, and mysterious. It cannot
  // happen from the viewer (the shrink setting floors at 0.02) but a caller passing a silly inset gets a
  // degenerate tile rather than an upside-down world.
  const ins = Math.max(0, Math.min(inset || 0, (size - 1) / 2));
  const keep = cells.filter((c) => c.y !== null && c.y !== undefined);
  const skipped = cells.length - keep.length;
  const nv = keep.length * 4;
  const pos = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  // 20,322 touched chunks is 81,288 corners, past what a Uint16 index can name.
  const idx = nv < 65536 ? new Uint16Array(keep.length * 6) : new Uint32Array(keep.length * 6);
  const max = keep.reduce((m, c) => (c.n > m ? c.n : m), 0);
  let p = 0, t = 0;
  for (const c of keep) {
    // `inset` is why the overlay stops being a floor of paint. A tile the full 16 x 16 covers the chunk
    // it describes, so a lit overlay reads as flat tiles welded together and the world under it
    // disappears; pulling each tile in by a block or two leaves the seams open and keeps the terrain
    // readable. It is geometry, not blending, so it costs no extra fill and no shader.
    const x0 = c.cx * size + ins, z0 = c.cz * size + ins, x1 = x0 + size - ins * 2, z1 = z0 + size - ins * 2;
    const y = c.y + bias;
    const [r, g, b] = heatLinear(c.n, max);
    // `p` is the running corner count, so it is also this quad's first corner number. Getting that
    // wrong is silent in a settled frame and catastrophic in a big one: the last index must name the
    // last corner, which is what the test asserts.
    const v0 = p;
    // p0, p3, p2, p1 - (p3-p0) x (p1-p0) points at +Y.
    pos[p * 3] = x0; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z0;
    pos[(p + 1) * 3] = x0; pos[(p + 1) * 3 + 1] = y; pos[(p + 1) * 3 + 2] = z1;
    pos[(p + 2) * 3] = x1; pos[(p + 2) * 3 + 1] = y; pos[(p + 2) * 3 + 2] = z1;
    pos[(p + 3) * 3] = x1; pos[(p + 3) * 3 + 1] = y; pos[(p + 3) * 3 + 2] = z0;
    for (let k = 0; k < 4; k++) { col[(p + k) * 3] = r; col[(p + k) * 3 + 1] = g; col[(p + k) * 3 + 2] = b; }
    idx[t++] = v0; idx[t++] = v0 + 1; idx[t++] = v0 + 2;
    idx[t++] = v0; idx[t++] = v0 + 2; idx[t++] = v0 + 3;
    p += 4;
  }
  return { pos, col, idx, quads: keep.length, verts: nv, indices: idx.length, skipped, inset: ins };
}

/**
 * Vertical cages over the cells a "find the bases" query picked out. Lines, not boxes: a marker has
 * to be legible from 10 km away and must not cost fill, and four corner lines read as a column while
 * one centre line disappears when it lands behind a hill.
 */
export function buildPins(cells, { height = 40, size = 16, inset = 1 } = {}) {
  const pos = new Float32Array(cells.length * 8 * 3);
  let p = 0;
  for (const c of cells) {
    if (c.y === null || c.y === undefined) continue;
    const x0 = c.cx * size + inset, z0 = c.cz * size + inset;
    const x1 = x0 + size - inset * 2, z1 = z0 + size - inset * 2;
    const y0 = c.y + 0.2, y1 = c.y + height;
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
      pos[p * 3] = x; pos[p * 3 + 1] = y0; pos[p * 3 + 2] = z;
      p++;
      pos[p * 3] = x; pos[p * 3 + 1] = y1; pos[p * 3 + 2] = z;
      p++;
    }
  }
  return { pos: pos.subarray(0, p * 3), verts: p };
}

// ---- the point query: what happened to this block -------------------------------------------------

/** Rows within `r` blocks of a point. r = 0 is that exact block, r = 1 the block and its face-neighbours. */
export function nearRows(rows, x, y, z, r = 1) {
  return rows.filter((w) => Math.abs(w.x - x) <= r && Math.abs(w.y - y) <= r && Math.abs(w.z - z) <= r);
}

/**
 * "Who placed this", summed. The per-player and per-kind counts are what the card leads with; the
 * list of rows underneath is the evidence. Blocks are counted by the name the log gives for the kind
 * of action (a break names the block that left, a place the block that arrived).
 */
export function summarizeRows(rows) {
  const byPlayer = {}, byKind = {}, byBlock = {};
  let t0 = Infinity, t1 = -Infinity;
  for (const w of rows) {
    const who = w.player || w.source || '(unknown)';
    byPlayer[who] = (byPlayer[who] ?? 0) + 1;
    const kind = ACTION_NAME[w.cls] ?? `#${w.cls}`;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (w.block) byBlock[w.block] = (byBlock[w.block] ?? 0) + 1;
    if (w.t < t0) t0 = w.t;
    if (w.t > t1) t1 = w.t;
  }
  return { n: rows.length, byPlayer, byKind, byBlock, t0, t1 };
}

const pad = (v, n = 2) => String(v).padStart(n, '0');

/** Same wall-clock shape the ledger database itself writes, so a hand check against SQLite matches. */
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** How long ago, in the unit that reads well: a base built last week should not say 0.04 years. */
export function timeAgo(ms, nowMs = Date.now()) {
  const s = Math.max(0, (nowMs - ms) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)} d ago`;
  if (s < 63072000) return `${(s / 2629800).toFixed(1)} mo ago`;
  return `${(s / 31557600).toFixed(1)} yr ago`;
}

/** One evidence line. Kept here because its wording is the part a person actually reads. */
export function rowLine(row, nowMs = Date.now(), at = null) {
  const who = row.player || row.source || '?';
  const kind = ACTION_NAME[row.cls] ?? `#${row.cls}`;
  // `at` prints how far this row's block is from the one being asked about. A card of near-rows is 14
  // copies of nearly the same coordinates otherwise, and that is what makes the line overflow.
  const where = at ? `Δ${row.x - at[0]},${row.y - at[1]},${row.z - at[2]}` : `at ${row.x},${row.y},${row.z}`;
  return `${formatTime(row.t)}  ${who}  ${kind}  ${row.block || '(no block named)'}` +
    `  ${where}  ${timeAgo(row.t, nowMs)}`;
}
