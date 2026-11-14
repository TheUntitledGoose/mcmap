// M15: the stand-in bodies the page draws, as DATA. DOM-free and three-free like the rest of web/js,
// so a Node test can ask it what a body looks like without a browser and without a scene graph.
//
// Where a person is allowed to be is decided in shared/ghosts.mjs (hand-attributed rows, cut by silence
// gaps). This file only answers "given those bodies, what do I hand the GPU, and what do I write next to
// them". Two rules hold it honest:
//
//   - The figure is the Minecraft player model, in the exact sizes the model is built in: head 8x8x8,
//     torso 8x12x4, arms 4x12x4 (3 wide for a slim skin), legs 4x12x4, stacked to 32 px = 2.0 blocks
//     (shared/skinlayout.mjs). That is NOT the 0.6 x 1.8 the walking physics uses, and both numbers are
//     right: the hitbox is shorter than the model because the head pokes above it.
//   - A skin is data the SERVER has, never something the page fetches from the internet. tools/fetch-skins.mjs
//     asks Mojang once, on a machine with network, and writes build/skins/. The page reads /skins/.
//     A player with no entry there still stands: same geometry, their own colour instead of a texture.
//   - The hedge travels with the body. `seat` ('ground' / 'float' / 'unknown' / 'near') says how much of
//     the feet position was inferred, and `bodyLabel` puts that in the text next to the body rather than
//     in a tooltip nobody opens.
import { bodiesAt, seatOf, trackOf, nearestVisit, RUN_GAP_SEC } from '../../shared/ghosts.mjs';
import { C_FULL, C_PASS, BODY as HITBOX } from '../../shared/player.mjs';
import { bodyMesh, modelBox, PX, MODEL_H } from '../../shared/skinlayout.mjs';

/**
 * The physics answer, unchanged: what a walking body occupies and what a ray must clear. 0.6 x 1.8, with
 * the eye at 1.62. Kept as the name `BODY_H`/`BODY_W` because the sight probe (`BODY_SEE`) and the click
 * box are all keyed to it.
 */
export const BODY_H = HITBOX.h;
export const BODY_W = HITBOX.w;

/** What the DRAWN figure is: 32 texture pixels of model, feet at the block above the floor. */
export { MODEL_H, modelBox };

/**
 * Deterministic colour per timeline player index, in LINEAR rgb (three.js vertex colours are linear
 * here, the same convention the shell layers use). Twelve hues, far enough apart that five bodies in one
 * frame are five people, and stable across reloads so the panel list and the bodies match.
 *
 * Kept in 0..1, NOT the 0..255 bytes the chunk mesher feeds a NORMALIZED u8 attribute: the body and route
 * buffers are Float32, where three reads the number as light itself. The first version of this line ended
 * in `* 255`, every component clipped to 1, and the players painted as white silhouettes.
 */
export const PLAYER_TINT = Array.from({ length: 12 }, (_, i) => {
  const hue = (i * 137.5) % 360;                       // golden-angle spread: no two neighbours alike
  const s = 0.62, l = 0.55;
  const rgb = hslToRgb(hue / 360, s, l);
  return rgb.map((v) => Math.min(1, Math.max(0, srgbToLinear(v))));
});
function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
function srgbToLinear(v) { return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
export const tintOf = (player) => PLAYER_TINT[(player | 0) % PLAYER_TINT.length];

/** The page's collision codes -> the three-way answer seatOf wants. */
export const solidFn = (cellAt) => (x, y, z) => {
  const c = cellAt(x, y, z);
  return c === C_FULL ? true : c === C_PASS ? false : null;
};

/**
 * Does a wall stand between an eye and this body?
 *
 * Walks from the body toward the eye through the voxels the browser actually holds and stops at the first
 * solid one. Three answers, because a chunk nobody fetched is not a wall:
 *
 *   'wall'    every way to reach them is blocked by a known solid block - they are behind it, and so is its
 *             pixel
 *   'clear'   at least one way to reach them (head, chest or hip, across the shoulders) is known and empty
 *   'unknown' no way is known-empty, but part of the way is ground the browser has not fetched - not proof
 *             of anything, so the page shows the person: nothing is drawn out there either
 *
 * Several rays, not one, because "is this person visible" is not "is the line to their chest clear": a body
 * in a one-block tunnel grazes a wall corner on the way to the middle of them, and a single ray then hides
 * a person the frame is showing. Any part seen is enough.
 *
 * The body's own column at or below their feet is never the wall: the ground they stand on is nearer than
 * their chest, and a block one over at foot height is a step, not an occluder. A block at their own height
 * one column over IS still a wall - that is a tunnel wall, and it is why this test is positional rather
 * than a height band.
 *
 * One rule, two consumers: the people layer picks its depth policy from this, and a click asks it the same
 * question, so the picture and the answer cannot disagree.
 */
const BODY_SEE = [1.62, 1.0, 0.35];          // head, chest, hip
const BODY_ACROSS = [-0.35, 0, 0.35];        // across the shoulders, square to the eye line

export function bodyWall(cellAt, b, eye, { max = 256, minStep = 0.6 } = {}) {
  const feet = b.floor ?? b.y - 1;
  const dx0 = eye[0] - (b.x + 0.5), dz0 = eye[2] - (b.z + 0.5);
  const flat = Math.hypot(dx0, dz0) || 1;
  const px = -dz0 / flat, pz = dx0 / flat;            // the horizontal direction across the body
  let unknown = false;
  for (const hgt of BODY_SEE) {
    for (const s of BODY_ACROSS) {
      const r = rayClear(cellAt, b, feet, b.x + 0.5 + px * s, b.y + hgt, b.z + 0.5 + pz * s, eye, max, minStep);
      if (r === 'clear') return 'clear';               // one clear line is enough to see a person
      if (r === 'unknown') unknown = true;
    }
  }
  return unknown ? 'unknown' : 'wall';
}

function rayClear(cellAt, b, feet, tx, ty, tz, eye, max, minStep) {
  const dx = eye[0] - tx, dy = eye[1] - ty, dz = eye[2] - tz;
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-6)) return 'clear';                   // an eye inside the person answers for them
  // Samples are capped, so the step grows with the distance: never finer than `minStep` (a one-block wall
  // must not be stepped over), and never more than `max` samples on the way.
  const step = Math.max(minStep, len / max);
  let unknown = false;
  for (let t = step; t < len; t += step) {
    const k = t / len;
    const x = Math.floor(tx + dx * k), y = Math.floor(ty + dy * k), z = Math.floor(tz + dz * k);
    if (Math.abs(x - b.x) <= 1 && Math.abs(z - b.z) <= 1 && y <= feet) continue;
    const c = cellAt(x, y, z);
    if (c === C_FULL) return 'wall';
    if (c !== C_PASS) unknown = true;
  }
  return unknown ? 'unknown' : 'clear';
}

/**
 * Every body the evidence supports at `sec`, with its feet placed.
 *
 * `cellOf(cellIndex) -> {cx, cz}` is the pack's chunk table: a timeline row carries a cell INDEX and
 * chunk-local x/z, so without this table no body can be placed in the world at all.
 * `cellAt(x, y, z)` is the page's collision read (the payload voxels), used only to find a floor.
 */
export function bodiesHere(tl, presence, sec, { gap = null, cellOf, cellAt = null } = {}) {
  const solid = cellAt ? solidFn(cellAt) : null;
  const out = [];
  for (const ans of bodiesAt(presence, sec, { gap })) {
    if (ans.absent) {
      // An absent answer still carries the facts a sentence needs: how stale the evidence was, when the
      // freshest action actually was, and this player's own window. 'ahead' has no freshest action.
      const p = presence.players.find((q) => q.player === ans.player) ?? null;
      out.push({
        player: ans.player, absent: ans.absent, age: ans.age ?? null, acted: ans.acted ?? null,
        firstSec: p && p.sec.length ? p.sec[0] : null,
        lastSec: p && p.sec.length ? p.sec[p.sec.length - 1] : null,
        visit: ans.visit ?? null,
      });
      continue;
    }
    const s = seatOf(tl, ans.row, { solid, worldOf: cellOf });
    out.push({
      player: ans.player, row: ans.row, sec: tl.sec[ans.row], age: ans.age,
      action: tl.action[ans.row], block: tl.nameOf(ans.row), was: tl.wasOf(ans.row),
      absent: null, ...s,
      cell: ans.cell, visit: ans.visit ? { k0: ans.visit.k0, k1: ans.visit.k1, t0: ans.visit.t0, t1: ans.visit.t1, n: ans.visit.n } : null,
    });
  }
  return out;
}

const box = (pos, col, x0, y0, z0, x1, y1, z1, rgb) => {
  // Six faces, two triangles each, written the same way the mesher writes a cube face: this is a
  // silhouette, not a model, so no UVs and no shading - the colour carries the identity.
  const q = (a, b, c, d) => { for (const p of [a, b, c, a, c, d]) { pos.push(p[0], p[1], p[2]); col.push(rgb[0], rgb[1], rgb[2]); } };
  const X = (n) => x0 + n * (x1 - x0), Y = (n) => y0 + n * (y1 - y0), Z = (n) => z0 + n * (z1 - z0);
  q([X(0), Y(0), Z(1)], [X(1), Y(0), Z(1)], [X(1), Y(1), Z(1)], [X(0), Y(1), Z(1)]);
  q([X(1), Y(0), Z(0)], [X(0), Y(0), Z(0)], [X(0), Y(1), Z(0)], [X(1), Y(1), Z(0)]);
  q([X(1), Y(0), Z(1)], [X(1), Y(0), Z(0)], [X(1), Y(1), Z(0)], [X(1), Y(1), Z(1)]);
  q([X(0), Y(0), Z(0)], [X(0), Y(0), Z(1)], [X(0), Y(1), Z(1)], [X(0), Y(1), Z(0)]);
  q([X(0), Y(1), Z(1)], [X(1), Y(1), Z(1)], [X(1), Y(1), Z(0)], [X(0), Y(1), Z(0)]);
  q([X(0), Y(0), Z(0)], [X(1), Y(0), Z(0)], [X(1), Y(0), Z(1)], [X(0), Y(0), Z(1)]);
};

/**
 * One buffer for every body on screen, in world block coordinates like every other ledger layer.
 * `per` records the triangle range of each body so the page can say which body a ray hit without
 * raycasting six meshes.
 *
 * `skinOf(player)` returns `{column, slim}` (that person's slot in the server's skin strip) or null. A
 * null answer is NOT a different figure: the body is cut from the same twelve boxes and its UVs point at
 * the strip's white end column, so the vertex colours below paint it instead of a texture. One geometry
 * kind, one draw call per body either way, and "this player has no skin" stays a material answer rather
 * than a second code path that can drift.
 *
 * `columns` is the width of the skin strip in 64-px cells, including that white cell, because a UV is only
 * meaningful against the texture it is going to sample.
 */
export function bodyGeom(bodies, { skinOf = null, overlay = true, columns = 1, whiteColumn = 0 } = {}) {
  const pos = [], col = [], uv = [];
  const per = [];
  for (const b of bodies) {
    if (b.absent) continue;
    const skin = skinOf ? skinOf(b.player) : null;
    const m = bodyMesh({
      slim: !!skin?.slim, overlay,
      column: skin ? skin.column : whiteColumn,
      texW: 64 * columns, texH: 64,
    });
    const start = pos.length / 3;
    const tint = tintOf(b.player);
    const dark = tint.map((v) => v * 0.55);
    const light = tint.map((v) => Math.min(1, v * 1.25 + 0.05));
    const x = b.x + 0.5, z = b.z + 0.5, fy = b.y;           // feet on the block above the floor
    for (let i = 0; i < m.pos.length; i += 3) {
      pos.push(x + m.pos[i], fy + m.pos[i + 1], z + m.pos[i + 2]);
      if (skin) { col.push(1, 1, 1); continue; }   // the texture IS the colour: multiply by white
      // Same shading the stand-in had, read off the model instead of off a made-up box: legs dark, torso
      // and arms the player's colour, head light.
      const ypx = m.pos[i + 1] * PX;
      const c = ypx >= 24 ? light : ypx >= 12 ? tint : dark;
      col.push(c[0], c[1], c[2]);
    }
    for (let i = 0; i < m.uv.length; i += 2) uv.push(m.uv[i], m.uv[i + 1]);
    // `slim` travels with the body because the box around a person, and the tag over their head, have to
    // fit the model that is actually drawn: 16px across with 4px arms, 14px with the 3px slim arms.
    per.push({ player: b.player, from: start, to: pos.length / 3, x, y: fy, z, skinned: !!skin, slim: !!skin?.slim });
  }
  return {
    pos: new Float32Array(pos), col: new Float32Array(col), uv: new Float32Array(uv),
    verts: pos.length / 3, tris: pos.length / 9, per,
  };
}

/**
 * The route each standing body walked during the visit it stands in. Thinned by shared/ghosts.mjs to
 * `max` points and always ending where the player left, so a route never claims a person stood at a
 * place they only passed.
 */
export function trackGeom(tl, presence, bodies, { max = 96, cellOf } = {}) {
  const pos = [], col = [];
  let lines = 0;
  for (const b of bodies) {
    if (b.absent || b.visit === null) continue;
    const p = presence.players.find((q) => q.player === b.player);
    if (!p) continue;
    const visit = p.visits.find((v) => v.k0 === b.visit.k0 && v.k1 === b.visit.k1);
    if (!visit) continue;
    const pts = trackOf(tl, p, visit, { max, worldOf: cellOf });
    const tint = tintOf(b.player);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], c = pts[i];
      if (a.x === c.x && a.z === c.z) continue;
      const y = Math.max(tl.y(p.rows[visit.k0 + i]), 0) + 0.1;
      pos.push(a.x + 0.5, y, a.z + 0.5, c.x + 0.5, y, c.z + 0.5);
      col.push(tint[0], tint[1], tint[2], tint[0], tint[1], tint[2]);
      lines++;
    }
  }
  return { pos: new Float32Array(pos), col: new Float32Array(col), lines };
}

/**
 * How much of the log's time actually supports a body somewhere, and how many people at once.
 *
 * This is the number that makes "nobody is standing here" readable instead of broken: the overworld's
 * 393 visits cover 183,846 of its 71,042,477 seconds, which is 0.26% of the log. Without it a viewer
 * scrubs to the middle of the log, sees nobody, and concludes the feature is off.
 */
export function occupancyOf(presence, spanSec) {
  const iv = [];
  for (const p of presence.players) for (const v of p.visits) iv.push([v.t0, v.t1]);
  iv.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0, cur = -1;
  for (const [a, b] of iv) {
    if (a > cur) { covered += b - a; cur = b; }
    else if (b > cur) { covered += b - cur; cur = b; }
  }
  // Peak players-at-once comes from the same intervals: +1 at a visit's start, -1 after its end.
  const marks = [];
  for (const [a, b] of iv) { marks.push([a, 1], [b + 1, -1]); }
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, peak = 0, peakAt = 0;
  for (const [s, d] of marks) {
    live += d;
    if (live > peak) { peak = live; peakAt = s; }
  }
  return {
    visits: iv.length, sec: covered, spanSec,
    pct: spanSec > 0 ? (100 * covered) / spanSec : 0,
    peak, peakAt, perPlayer: presence.players.map((p) => p.visits.reduce((a, v) => a + (v.t1 - v.t0), 0)),
  };
}

const ACTION_TEXT = ['changed', 'placed', 'broke', 'put something in', 'took something out', 'killed', 'acted'];
export const actionText = (byte) => ACTION_TEXT[Math.min(byte, ACTION_TEXT.length - 1)];

/**
 * Silence in the unit a person can read. "43,243 minutes before this moment" is technically a duration
 * and practically nonsense: the empty part of this log is months, so the ladder has to reach days.
 */
const longAgo = (sec) => {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${(s / 60).toFixed(0)} minutes`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} hours`;
  return `${(s / 86400).toFixed(1)} days`;
};

const SEAT_TEXT = {
  ground: '',
  float: ' - no floor found under it',
  unknown: ' - the ground under it is not loaded',
  near: ' - feet guessed',
};

/** The two lines of text a body gets: who, and what makes the viewer allowed to draw them. */
export function bodyLabel(tl, b, names = [], { now = null } = {}) {
  const who = names[b.player]?.name ?? `player ${b.player + 1}`;
  const what = `${actionText(b.action)}${b.block ? ` ${String(b.block).replace(/^minecraft:/, '')}` : ''}`;
  const ago = b.age <= 1 ? 'just now' : b.age < 120 ? `${b.age} s ago`
    : b.age < 7200 ? `${(b.age / 60).toFixed(0)} min ago`
    : b.age < 172800 ? `${(b.age / 3600).toFixed(1)} h ago` : `${(b.age / 86400).toFixed(1)} days ago`;
  return { name: who, sub: `${what}, ${ago}${SEAT_TEXT[b.seat] ?? ''}` };
}

/** The body's own words for why it is NOT on screen: 'ahead' and 'gap' are the only two answers. */
export function absentText(ans, names = [], stampOf = (s) => `${s} s`) {
  const who = names[ans.player]?.name ?? `player ${ans.player + 1}`;
  if (ans.absent === 'ahead') {
    return ans.firstSec === null || ans.firstSec === undefined
      ? `${who} has no logged hand action in this dimension at all`
      : `${who} has not acted yet here - the log's first action from them is at ${stampOf(ans.firstSec)}`;
  }
  if (ans.absent === 'gap') {
    return `${who} last did something at ${stampOf(ans.acted)}, ${longAgo(ans.age)} before this moment,`
      + ' and the next logged action is a jump away';
  }
  return `${who}: nobody can be placed from this row`;
}

/**
 * This player's hand actions nearest `sec`, newest first. The timeline already carries place, time,
 * kind and block name for every row, so a history list costs no request.
 */
export function historyNear(tl, presence, player, sec, { max = 12, cellOf } = {}) {
  const p = presence.players.find((q) => q.player === player);
  if (!p) return [];
  const rows = p.rows;
  let lo = 0, hi = rows.length;                      // rows are in time order: binary search the seam
  while (lo < hi) { const m = (lo + hi) >> 1; if (tl.sec[rows[m]] <= sec) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo - 1; i >= 0 && out.length < max; i--) {
    const r = rows[i];
    const c = cellOf ? cellOf(tl.cell[r]) : null;
    out.push({
      row: r, sec: tl.sec[r], action: tl.action[r], block: tl.nameOf(r),
      x: c ? c.cx * 16 + tl.x(r) : tl.x(r), y: tl.y(r), z: c ? c.cz * 16 + tl.z(r) : tl.z(r),
      seat: seatOf(tl, r, { worldOf: cellOf ?? (() => ({ cx: 0, cz: 0 })) }).seat,
    });
  }
  return out;
}

export { bodiesAt, nearestVisit, trackOf, seatOf, RUN_GAP_SEC };
