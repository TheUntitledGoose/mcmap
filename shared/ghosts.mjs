// M15.2 - where a player STOOD, worked out from what their hand DID (DOM-free, three-free).
//
// The ledger has no player positions. It has rows, and a row says "this player caused this block to
// change, at this second". That is evidence about a body, but only under two conditions, and this module
// exists to enforce both of them rather than leaving them to whatever code draws a person:
//
//   1. The cause has to be the player's own hand. Timeline v4 carries the source byte for exactly this:
//      of this save's 123,232 player-attributed overworld rows, 28,795 were caused by a creeper blast, a
//      wither skull, an end crystal or TNT the player happens to own, and a measured row of that kind
//      sits a median 20 blocks (p90 166) from that player's nearest hand-attributed row. `tl.byHand(i)`
//      is the gate, and nothing here bypasses it.
//
//   2. A body must not be stretched across the gaps. A player's hand rows are dense (p50 1 s apart, p90
//      5-20 s) and the moves are tiny (p50 1 block between consecutive rows), so a minute of silence
//      already means they are elsewhere: across gaps over 300 s the hand has moved a median 52-155
//      blocks, p90 over 1,100 (build/dbg-gaps.mjs, all six players, overworld). So evidence is cut at
//      RUN_GAP_SEC into VISITS, and outside a visit the honest answer is "nobody stands here", not "the
//      last known body, forever".
//
// What this can never give you is the exact cell a body occupied: a crosshair hits a block at your feet,
// chest or head height, one to five blocks in front of you. `seatOf` reports which of its four answers
// it had to fall back to, and the page repeats that hedge wherever it draws a person.
//
// Coordinate note, because it is the easy mistake: `tl.x(i)`/`tl.z(i)` are LOCAL to the chunk (0..15)
// while `tl.y(i)` is a world Y. Anything that walks a column needs the cell table, so every function here
// that touches a position takes `worldOf(cellIndex) -> {cx, cz}` in the shape the pack reader already has.

import { TL_NO_PLAYER } from './ledger-pack.mjs';

/** Silence that ends a visit. Measured: see the header and build/dbg-gaps.mjs. */
export const RUN_GAP_SEC = 300;
/**
 * How far below the acted-on block to look for the floor a body would be standing on.
 * Measured on this save with build/dbg-seat.mjs (1,800 sampled hand rows, real region data, the real
 * collision table): a 4 block look finds a floor for 88% of actions, 8 blocks for 95%, 12 blocks for 97%.
 * Eight is where the curve flattens. The acted block sits ON its own floor at p50 and one above at p90,
 * and between two neighbouring actions of the same player the floor Y does not move at all (p50/p90/p99
 * = 0 blocks), so this does not make a body jitter while the playhead scrubs.
 */
export const SEAT_LOOK = 8;

/** The row a body may stand on: a named player AND that player's own hand caused it. */
export const handRowAt = (tl, i) => tl.player[i] !== TL_NO_PLAYER && tl.byHand(i);

const localXY = () => ({ cx: 0, cz: 0 });

/**
 * All hand rows, in time order (the timeline rows already are). `who` is a timeline player index
 * (0-based); pass null for every player at once.
 */
export function handRows(tl, who = null) {
  const out = [];
  for (let i = 0; i < tl.count; i++) {
    if (!handRowAt(tl, i)) continue;
    if (who !== null && tl.player[i] !== who) continue;
    out.push(i);
  }
  return out;
}

/**
 * Split the hand rows into VISITS: a run of actions with no silence longer than `gap` inside it.
 *
 * One entry per player who ever acted, with `rows`/`sec` parallel arrays and their visits. The two
 * numbers a panel needs to be honest about come back too: `first`/`last` bound the window in which this
 * log can place a body at all - for this save that is 7.20 of 822 days, so a scrub outside it draws
 * nobody and has to say why.
 *
 * A visit is not a "session" in any game sense. It is the longest stretch of evidence that a person was
 * somewhere, and the only thing this file will let a renderer put a body inside.
 */
export function presenceOf(tl, { gap = RUN_GAP_SEC, who = null, worldOf = localXY } = {}) {
  const byPlayer = new Map();
  for (let i = 0; i < tl.count; i++) {
    if (!handRowAt(tl, i)) continue;
    const p = tl.player[i];
    if (who !== null && p !== who) continue;
    let list = byPlayer.get(p);
    if (!list) byPlayer.set(p, list = []);
    list.push(i);
  }
  const players = [];
  for (const [p, rows] of [...byPlayer].sort((a, b) => a[0] - b[0])) {
    const sec = rows.map((i) => tl.sec[i]);
    const visits = [];
    let start = 0;
    for (let k = 1; k <= rows.length; k++) {
      if (k < rows.length && sec[k] - sec[k - 1] <= gap) continue;
      const a = rows[start], b = rows[k - 1];
      const ca = worldOf(tl.cell[a]), cb = worldOf(tl.cell[b]);
      const x0 = ca.cx * 16 + tl.x(a), z0 = ca.cz * 16 + tl.z(a);
      const x1 = cb.cx * 16 + tl.x(b), z1 = cb.cz * 16 + tl.z(b);
      visits.push({
        player: p,
        k0: start, k1: k - 1,                 // this player's rows, inclusive
        first: a, last: b,                    // timeline row indices
        t0: sec[start], t1: sec[k - 1],       // seconds since the timeline base
        x0, z0, x1, z1,
        cells: new Set(rows.slice(start, k).map((i) => tl.cell[i])).size,
        n: k - start,
        // How far apart the visit's first and last action are, in blocks: a straight line, not the path
        // anybody walked. It is what tells a "12 actions, 3 blocks" sit-down from a 900-block trip.
        across: Math.max(Math.abs(x0 - x1), Math.abs(z0 - z1)),
      });
      start = k;
    }
    players.push({ player: p, rows, sec, visits, first: sec[0], last: sec[sec.length - 1] });
  }
  const first = players.length ? Math.min(...players.map((x) => x.first)) : null;
  const last = players.length ? Math.max(...players.map((x) => x.last)) : null;
  return {
    gap, players, first, last,
    spanSec: first === null ? 0 : last - first,
    logSec: tl.spanSec,
    handRows: players.reduce((a, x) => a + x.rows.length, 0),
    visits: players.reduce((a, x) => a + x.visits.length, 0),
  };
}

/**
 * The body for each player at one second since the timeline base - or the reason there is none.
 *
 * `absent` is never a bare false: it names which honest answer applies, because "nobody is here" on
 * 2025-03-02 is a fact about the log and the viewer has to be able to say so out loud:
 *   'ahead' - this player acted, but only later than this second
 *   'gap'   - the freshest hand row behind is older than `gap`, or a `gap`-sized hole opens right after
 *             it: the visit ended, and there is no evidence of a body anywhere
 *
 * `gap` may be set tighter than the presence layer's own cut. That is the point of the `hole` half of the
 * test: a visit built at 300 s still contains a 240 s silence, and somebody asking "is a body here RIGHT
 * NOW" is allowed to ask with a stricter rule than the one that grouped the visits.
 */
export function bodiesAt(presence, sec, { gap = null } = {}) {
  const cut = gap ?? presence.gap;
  const out = [];
  for (const p of presence.players) {
    // Parallel `rows`/`sec` are time ordered, so the freshest evidence is a binary search.
    let lo = 0, hi = p.sec.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (p.sec[mid] <= sec) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) { out.push({ player: p.player, k: -1, row: -1, absent: 'ahead' }); continue; }
    const age = sec - p.sec[at];
    const hole = at + 1 < p.sec.length && p.sec[at + 1] - p.sec[at] > cut;
    if (age > cut || hole) {
      out.push({ player: p.player, k: at, row: p.rows[at], absent: 'gap', age, acted: p.sec[at] });
      continue;
    }
    out.push({
      player: p.player, k: at, row: p.rows[at], age,
      visit: visitOfK(p, at), absent: null,
    });
  }
  return out;
}

/** Which visit this row index belongs to (linear: a player has tens of visits, and this runs on a click). */
export function visitOfK(p, k) {
  for (const v of p.visits) if (k >= v.k0 && k <= v.k1) return v;
  return null;
}

/**
 * The floor a body would be standing on, under the block its hand acted on.
 *
 * `solid(wx, wy, wz)` is the caller's voxel truth (the page's chunk payload), in WORLD blocks, and it
 * answers three ways because the browser only ever holds some of the world:
 *   true   a block stands there        -> 'ground', feet on top of it
 *   false  air, water, a plant, ...    -> keep walking down
 *   null   no voxels for that cell     -> 'unknown' if no floor turns up
 * Without any `solid`: 'near', one block above the acted block.
 *
 * The four answers are the honest set: 'ground' (a floor within `SEAT_LOOK`), 'float' (every cell below
 * is known and none of it is solid - a body over a ravine), 'unknown' (the voxels below are not held,
 * so the floor is not knowable from here), 'near' (no voxel data supplied at all).
 *
 * A place leaves a solid block at the acted voxel, so it supports the body. A break usually takes the
 * block a body was standing on, so the payload there reads air and the search finds the floor one lower.
 * One rule covers both: walk DOWN from the acted block, inclusive, and stand on the first solid thing.
 * Measured on this save (build/dbg-seat.mjs): 95% of hand rows find a floor within 8 blocks, and the
 * floor Y never moves between a player's neighbouring actions, so a scrubbing playhead does not make a
 * body hop up and down.
 */
export function seatOf(tl, row, { solid = null, look = SEAT_LOOK, worldOf = localXY } = {}) {
  const c = worldOf(tl.cell[row]);
  const wx = c.cx * 16 + tl.x(row), wz = c.cz * 16 + tl.z(row), wy = tl.y(row);
  if (solid) {
    let holes = false;
    for (let d = 0; d <= look; d++) {
      const fy = wy - d;
      const s = solid(wx, fy, wz);
      if (s === true) return { x: wx, y: fy + 1, z: wz, floor: fy, seat: 'ground', above: d };
      if (s === null || s === undefined) holes = true;
    }
    return { x: wx, y: wy + 1, z: wz, floor: null, seat: holes ? 'unknown' : 'float', above: null };
  }
  return { x: wx, y: wy + 1, z: wz, floor: null, seat: 'near', above: null };
}

/**
 * A visit's path, thinned to `max` points. A visit can hold tens of thousands of rows; a polyline does
 * not need one point per row, and thinning by equal stride keeps the shape instead of its first minute.
 * The last point is always kept: a track that stops short of the moment the player left is a lie about
 * where the visit ended.
 */
export function trackOf(tl, p, visit, { max = 256, worldOf = localXY } = {}) {
  const n = visit.k1 - visit.k0 + 1;
  if (max < 2) { const r = p.rows[visit.k1]; return [pointOf(tl, r, worldOf)]; }
  // Room for the exit point inside `max`, not on top of it: a caller that asked for 256 points gets 256.
  const stride = Math.max(1, Math.ceil((n - 1) / (max - 1)));
  const pts = [];
  const push = (row) => pts.push(pointOf(tl, row, worldOf));
  for (let k = visit.k0; k <= visit.k1; k += stride) push(p.rows[k]);
  const last = p.rows[visit.k1];
  if (!pts.length || pts[pts.length - 1].row !== last) push(last);
  return pts;
}
const pointOf = (tl, row, worldOf) => {
  const c = worldOf(tl.cell[row]);
  return { row, sec: tl.sec[row], x: c.cx * 16 + tl.x(row), y: tl.y(row), z: c.cz * 16 + tl.z(row) };
}

/**
 * The visit nearest a second: what a "jump to when anybody was next here" control needs, and what the
 * panel quotes when the playhead sits in a 600-day hole and draws nobody.
 */
export function nearestVisit(presence, sec) {
  let best = null;
  for (const p of presence.players) {
    for (const v of p.visits) {
      const d = sec < v.t0 ? v.t0 - sec : sec > v.t1 ? sec - v.t1 : 0;
      if (!best || d < best.dist) best = { player: p.player, visit: v, dist: d, inside: d === 0 };
    }
  }
  return best;
}
