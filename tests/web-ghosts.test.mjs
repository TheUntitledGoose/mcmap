// M15: the page's body view - geometry, colour, labels, history - against a real pack timeline.
//
// What these tests guard is the part a screenshot cannot: that a body lands in the WORLD rather than in
// the chunk-local grid, that per-body triangle ranges are the ranges a ray hit is resolved with, that a
// float is labelled as a float, and that a history list never leaks another player's rows.
// The geometry tests also pin the model sizes the request was about (8x8x8 head, 8x12x4 torso, 4x12x4
// limbs, 3px arms when slim), because "it looks like Minecraft" is not a number a later pass can keep.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPack } from '../server/ledger-pack.mjs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { presenceOf } from '../shared/ghosts.mjs';
import { C_FULL, C_PASS, C_UNKNOWN } from '../shared/player.mjs';
import {
  bodiesHere, bodyGeom, bodyWall, trackGeom, bodyLabel, absentText, historyNear, tintOf, solidFn, occupancyOf,
  BODY_H, BODY_W, MODEL_H, modelBox,
} from '../web/js/ledger-ghosts.js';
import { fakeLog } from './fake-ledger.mjs';

const T = (sec) => 1717174690000 + sec * 1000;
const HAND = 'player';

function rig(rows) {
  const { buf } = buildPack(fakeLog(rows), 1, 'region');
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  return { tl, P, cellOf: (ci) => P.cell(ci), presence: presenceOf(tl, { worldOf: (ci) => P.cell(ci) }) };
}

test('a body lands in world blocks, not in the chunk-local grid the timeline stores', () => {
  // A cell at chunk (181, -626) is 2,896 blocks from the origin in x. Fold the cell table in, or every
  // body in the overworld piles up around (0, 0) - the bug the shared layer's localXY default exists to
  // make obvious.
  const rows = [[1, 181 * 16 + 5, 66, -626 * 16 + 7, 2, 1, T(100), 'minecraft:chest', '', HAND]];
  const { tl, presence, cellOf } = rig(rows);
  const [b] = bodiesHere(tl, presence, 100, { cellOf });
  assert.equal(b.absent, null);
  assert.deepEqual([b.x, b.z], [181 * 16 + 5, -626 * 16 + 7], 'world block coordinates');
  assert.equal(b.y, 67, 'feet one above the block they touched');
  assert.equal(b.seat, 'near', 'with no payload read the feet are a guess, and the record says which kind')
  assert.equal(b.block, 'minecraft:chest', 'the label needs the block name the timeline carries');
});

test('the floor comes from the page payload, and a column it has never fetched says so', () => {
  // A break (action id 3): the block the log names is gone from the save, so the payload reads air.
  const rows = [[1, 5, 66, 5, 3, 1, T(100), 'minecraft:stone', '', HAND]];
  const { tl, presence, cellOf } = rig(rows);
  const held = bodiesHere(tl, presence, 100, { cellOf, cellAt: (x, y, z) => (y <= 65 ? C_FULL : C_PASS) });
  assert.deepEqual([held[0].y, held[0].seat], [66, 'ground'], 'the mined block is air, so its neighbour holds them up');
  const dry = bodiesHere(tl, presence, 100, { cellOf, cellAt: () => C_PASS });
  assert.equal(dry[0].seat, 'float', 'known air all the way down is a fact, and it is labelled');
  const out = bodiesHere(tl, presence, 100, { cellOf, cellAt: () => C_UNKNOWN });
  assert.equal(out[0].seat, 'unknown', 'a chunk the page does not hold is not a claim about mid-air');
  const blind = bodiesHere(tl, presence, 100, { cellOf });
  assert.equal(blind[0].seat, 'near', 'no payload read at all: feet are guessed, and the text says it');
  assert.deepEqual(solidFn(() => C_FULL)(0, 0, 0), true);
  assert.deepEqual(solidFn(() => C_PASS)(0, 0, 0), false);
  assert.deepEqual(solidFn(() => C_UNKNOWN)(0, 0, 0), null);
});

test('one buffer holds every standing body, and each body keeps the triangle range a hit resolves with', () => {
  const rows = [];
  for (let p = 1; p <= 3; p++) rows.push([1, p * 4, 64, p * 4, 2, p, T(100), 'minecraft:stone', '', HAND]);
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 100, { cellOf });
  assert.equal(bodies.length, 3, 'three players, three bodies');
  const g = bodyGeom(bodies);
  assert.equal(g.per.length, 3);
  assert.equal(g.verts, g.tris * 3, 'a triangle soup: three vertices per triangle, no index buffer');
  assert.ok(g.verts >= 3 * 36, 'six boxes each, at least');
  let at = 0;
  for (const b of g.per) {
    assert.ok(b.from >= at && b.to > b.from, 'ranges are disjoint and in draw order');
    assert.ok(Number.isInteger(b.from) && Number.isInteger(b.to));
    at = b.to;
  }
  assert.equal(at, g.verts, 'and the last range ends where the buffer does');
  // The shape check runs over ONE body's own triangle range: the other two stand elsewhere in the world.
  // The figure is the MINECRAFT model, in pixel units (16 px = 1 block): legs 12, torso 12, head 8, so 32 px
  // = 2.0 blocks to the crown, and the second layer stands half a pixel proud of that. The physics hitbox
  // (0.6 x 1.8, shared/player.mjs) is a different question and stays what collision and sight use.
  const b0 = g.per[0], feet = b0.y, mb = modelBox(false, true);
  assert.ok(Math.abs(mb.h - 33 / 16) < 1e-9, '32px of model, half a pixel proud above and below');
  assert.ok(Math.abs(mb.top - 32.5 / 16) < 1e-9 && Math.abs(mb.bottom + 0.5 / 16) < 1e-9,
    'the second layer is inflated on all six sides, so it overhangs the soles too');
  const halfW = modelBox(false, true).w / 2;              // 8px torso + two 4px arms, +1px of jacket
  assert.ok(Math.abs(halfW - 17 / 32) < 1e-9, `arms reach ${halfW} blocks either side of the centre`);
  let seen = 0;
  for (let i = b0.from; i < b0.to; i++) {
    const o = i * 3;
    assert.ok(Math.abs(g.pos[o] - b0.x) <= halfW + 1e-6, 'arms stay inside the model width');
    // 8px of head is deeper than the 4px torso, and the jacket stands half a pixel proud of both.
    assert.ok(Math.abs(g.pos[o + 2] - b0.z) <= 9 / 32 + 1e-6, 'nothing reaches past the head, plus its half pixel');
    // 1e-3, not exact: the buffer is Float32, so the crown of the head lands 3e-6 above the ideal.
    assert.ok(g.pos[o + 1] >= feet + mb.bottom - 1e-3 && g.pos[o + 1] <= feet + mb.top + 1e-3,
      'nothing floats above the crown, and the jacket overhangs the soles by exactly its half pixel');
    seen++;
  }
  assert.equal(seen, b0.to - b0.from, 'every vertex of that range was checked');
  assert.deepEqual(tintOf(0), tintOf(0), 'a player keeps its colour across calls');
  assert.notDeepEqual(tintOf(0), tintOf(1), 'and two players do not share one');
});

test('the model is the Minecraft figure: 8x8x8 head, 8x12x4 torso, 4x12x4 limbs, in world blocks', () => {
  // The sizes the request was about, asserted as CORNER POSITIONS rather than vertex counts: a box's eight
  // corners are where a size claim is either true or false, and overlapping ranges (an arm touches the
  // torso's top ring) make "how many verts fall in this box" answer a question nobody asked.
  // No second layer here: a hat inflates every face by half a pixel and hides the numbers it should be
  // checked against - the overlay's own inflation is asserted separately.
  const rows = [[1, 40, 64, 40, 2, 1, T(100), 'minecraft:stone', '', HAND]];
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 100, { cellOf });
  const g = bodyGeom(bodies, { overlay: 0 });
  assert.equal(g.per.length, 1);
  const b = g.per[0];
  const pts = [];
  for (let k = b.from; k < b.to; k++) pts.push([g.pos[k * 3] - b.x, g.pos[k * 3 + 1] - b.y, g.pos[k * 3 + 2] - b.z]);
  const px = (n) => n / 16;
  const has = (x, y, z) => pts.some((p) => Math.abs(p[0] - px(x)) < 1e-6 && Math.abs(p[1] - px(y)) < 1e-6
    && Math.abs(p[2] - px(z)) < 1e-6);
  const corners = ([x0, x1, y0, y1, z0, z1]) => {
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
      assert.ok(has(x, y, z), `no corner at ${x},${y},${z} px - the box is not ${x1 - x0}x${y1 - y0}x${z1 - z0}`);
    }
  };
  // head 8 wide, 8 deep, 8 tall, sitting on the torso at y=24
  corners([-4, 4, 24, 32, -4, 4]);
  // torso 8 wide, 12 tall, 4 deep
  corners([-4, 4, 12, 24, -2, 2]);
  // arms 4 wide, 12 tall, 4 deep, hanging OUTSIDE the torso; legs the same size but side by side UNDER it.
  // That is the vanilla arrangement and it is why the figure is 16px across while its legs span only 8:
  // an arm at x=0 would be an arm through the middle of the body.
  corners([-8, -4, 12, 24, -2, 2]);
  corners([4, 8, 12, 24, -2, 2]);
  corners([-4, 0, 0, 12, -2, 2]);
  corners([0, 4, 0, 12, -2, 2]);
  // And nothing outside the figure: the whole soup stays inside 16px wide, 8px deep, 32px tall.
  let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity, loZ = Infinity, hiZ = -Infinity;
  for (const p of pts) {
    loX = Math.min(loX, p[0]); hiX = Math.max(hiX, p[0]);
    loY = Math.min(loY, p[1]); hiY = Math.max(hiY, p[1]);
    loZ = Math.min(loZ, p[2]); hiZ = Math.max(hiZ, p[2]);
  }
  assert.ok(Math.abs(hiX - px(8)) < 1e-6 && Math.abs(loX + px(8)) < 1e-6, '16px across, arms included');
  assert.ok(Math.abs(hiZ - px(4)) < 1e-6 && Math.abs(loZ + px(4)) < 1e-6, '8px deep, at the head');
  assert.ok(Math.abs(loY) < 1e-6, 'feet ON the floor block, not in it');
  assert.ok(Math.abs(hiY - px(32)) < 1e-6, 'crown 32px = 2.0 blocks up');
  assert.ok(Math.abs(modelBox(false, false).w - 1) < 1e-9 && Math.abs(modelBox(false, false).h - 2) < 1e-9,
    'and the box the page draws an outline with agrees with the geometry');
  // UVs exist for every corner and stay inside the single-cell texture.
  assert.equal(g.uv.length, g.verts * 2, 'a texel coordinate per corner');
  for (let k = 0; k < g.uv.length; k += 2) {
    assert.ok(g.uv[k] >= 0 && g.uv[k] <= 1, 'u inside the strip');
    assert.ok(g.uv[k + 1] >= 0 && g.uv[k + 1] <= 1, 'v inside the strip');
  }
});

test('a slim model has 3px arms, and a skinned body samples its own column of the strip', () => {
  const rows = [];
  for (let p = 1; p <= 2; p++) rows.push([1, 40 + 100 * p, 64, 40, 2, p, T(100), 'minecraft:stone', '', HAND]);
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 100, { cellOf });
  // Player 1 wears column 1 and is slim; player 2 has no skin and lands on the white column (2 of 3).
  const opts = {
    overlay: 1, columns: 3, whiteColumn: 2,
    skinOf: (p) => (p === bodies[0].player ? { column: 1, slim: true } : null),
  };
  const g = bodyGeom(bodies, opts);
  assert.equal(g.per[0].skinned, true, 'the first body has a skin');
  assert.equal(g.per[1].skinned, false, 'and the second does not');
  assert.equal(g.per[0].slim, true);
  // Classic: torso+arms = 8+4+4 = 16px. Slim: 8+3+3 = 14px. Measured off the geometry.
  const span = (e) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = e.from; i < e.to; i++) {
      const x = g.pos[i * 3] - e.x;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    return hi - lo;
  };
  assert.ok(Math.abs(span(g.per[0]) - 15 / 16) < 1e-5, `slim figure is 14px + 1px of jacket, got ${span(g.per[0]) * 16}`);
  assert.ok(Math.abs(span(g.per[1]) - 17 / 16) < 1e-5, `classic figure is 16px + 1px, got ${span(g.per[1]) * 16}`);
  // A skinned body's texel coordinates live in ITS column, and an unskinned one's in the white column.
  const inCol = (e, col) => {
    let bad = 0;
    for (let i = e.from * 2; i < e.to * 2; i += 2) {
      const px = g.uv[i] * 3 * 64;                    // texel coordinate across the whole strip
      // <= and >= at the cell edge are allowed on purpose: the rightmost texel column of an arm ends
      // exactly on the cell boundary, and a vertex sitting on that boundary reads as either side.
      if (px < col * 64 - 1e-6 || px > (col + 1) * 64 + 1e-6) bad++;
    }
    return bad;
  };
  assert.equal(inCol(g.per[0], 1), 0, 'the skinned body never samples another player');
  assert.equal(inCol(g.per[1], 2), 0, 'the skinless body sits on the white column');
  // A skinned body is tinted white, so the texture is the colour; a skinless one keeps its band colours.
  const c0 = g.col[g.per[0].from * 3];
  assert.equal(c0, 1, 'white for a textured body');
  assert.ok(g.col[g.per[1].from * 3] !== 1 || g.col[g.per[1].from * 3 + 1] !== 1,
    'the fallback body is tinted, because its strip cell is blank paper');
});

test('the second layer costs geometry and buys the hat: 36 quads base, 72 with it', () => {
  const rows = [[1, 40, 64, 40, 2, 1, T(100), 'minecraft:stone', '', HAND]];
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 100, { cellOf });
  const base = bodyGeom(bodies, { overlay: 0 });
  const full = bodyGeom(bodies, { overlay: 1 });
  assert.equal(base.per[0].to - base.per[0].from, 6 * 6 * 6, 'six boxes, six faces, two triangles a face');
  assert.equal(full.per[0].to - full.per[0].from, 2 * 6 * 6 * 6, 'and the same again, standing proud');
});

test('the label says who, what they did, how long ago, and how much of the feet position is a guess', () => {
  const names = [{ name: 'playerA' }];
  const rows = [[1, 5, 64, 5, 2, 1, T(100), 'minecraft:torch', '', HAND]];
  const { tl, presence, cellOf } = rig(rows);
  // Two minutes after the torch: still inside the silence cut, so the body stands. (Four minutes would
  // not: RUN_GAP_SEC is 300 s, and the label test below asserts that answer instead.)
  const [b] = bodiesHere(tl, presence, 120, { cellOf });
  const lab = bodyLabel(tl, b, names);
  assert.equal(lab.name, 'playerA');
  assert.match(lab.sub, /placed torch, 2 min ago/, 'who, what, and how long ago, in one line');
  assert.equal(lab.sub.includes('no floor'), false, 'this one stands on its own placed block');
  const dry = bodiesHere(tl, presence, 120, { cellOf, cellAt: () => C_PASS })[0];
  assert.match(bodyLabel(tl, dry, names).sub, /no floor found under it/);
  // 400 s after the torch: past the 300 s silence cut, so nobody stands here, and the record
  // still carries the facts the sentence quotes.
  const off = bodiesHere(tl, presence, 400, { cellOf })[0];
  assert.equal(off.absent, 'gap');
  assert.equal(off.age, 400, 'how stale the freshest evidence was');
  assert.equal(off.acted, 0, 'when that action actually was, in timeline seconds');
  assert.deepEqual([off.firstSec, off.lastSec], [0, 0], "that player's whole window in this dimension");
  assert.match(absentText(off, names, (x) => `sec ${x}`), /playerA last did something at sec 0, 7 minutes before/);
  assert.match(absentText({ player: 0, absent: 'ahead', firstSec: 55 }, names, (x) => `sec ${x}`),
    /has not acted yet here - the log's first action from them is at sec 55/);
  assert.match(absentText({ player: 0, absent: 'ahead' }, names),
    /playerA has no logged hand action in this dimension at all/);
});

test('historyNear quotes that player\'s own rows, newest first, and no request is needed', () => {
  const rows = [];
  for (let k = 0; k < 20; k++) rows.push([1, 40 + k, 70, 9, 2, 1, T(k * 30), 'minecraft:stone', '', HAND]);
  for (let k = 0; k < 20; k++) rows.push([1, 900, 70, 900, 2, 2, T(k * 30), 'minecraft:dirt', '', HAND]);
  // (row shape: worldId, x, y, z, actionId, playerId, timeMs, block, oldBlock, source)
  const { tl, presence, cellOf } = rig(rows);
  const list = historyNear(tl, presence, 0, 300, { max: 4, cellOf });
  assert.equal(list.length, 4);
  assert.ok(list.every((h) => tl.player[h.row] === 0), 'only this player\'s rows - the other 20 are somebody else\'s');
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].sec >= list[i].sec, 'newest first');
  assert.equal(list[0].sec, 300, 'the newest action AT OR BEFORE the playhead, not the one after it');
  // The 11th action of that run sits at block x 50 - chunk 3's cell, local x 2. Reading tl.x() as a
  // world coordinate would have said 2, and the body would stand 48 blocks off.
  assert.deepEqual([list[0].x, list[0].y, list[0].z], [50, 70, 9], 'world blocks, from the cell table');
  assert.equal(tl.x(list[0].row), 2, 'the timeline itself stays chunk-local');
  assert.equal(historyNear(tl, presence, 77, 300, { cellOf }).length, 0, 'a player who is not there has no history');
});

test('a route is drawn only for a body that stands in a visit, and it stays in world blocks', () => {
  const rows = [];
  for (let k = 0; k < 12; k++) rows.push([1, 300 + k, 64 + (k % 3), 500, 2, 1, T(k * 20), 'minecraft:stone', '', HAND]);
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 220, { cellOf });
  const g = trackGeom(tl, presence, bodies, { max: 8, cellOf });
  assert.ok(g.lines > 0 && g.lines <= 8, `a thinned route, ${g.lines} segments`);
  assert.equal(g.pos.length, g.lines * 6);
  const xs = [];
  for (let i = 0; i < g.pos.length; i += 3) xs.push(g.pos[i]);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 1, 'the route has extent, it is not one point');
  assert.ok(Math.min(...xs) >= 300 && Math.max(...xs) <= 312, 'world blocks, not chunk-local');
  // an absent body has no route: a dotted line to nowhere is exactly the lie this feature must not tell
  assert.equal(trackGeom(tl, presence, [{ player: 0, absent: 'gap', visit: null }], { cellOf }).lines, 0);
});

test('the page can say how much of the log a body is supported anywhere in, and how many at once', () => {
  // Two players whose visits overlap: the coverage is a UNION of seconds, not a sum, or a panel would
  // claim more of the log is populated than the log holds.
  const rows = [];
  for (let k = 0; k <= 5; k++) rows.push([1, 10 + k, 64, 10, 2, 1, T(k * 20), 'minecraft:stone', '', HAND]);
  for (let k = 0; k <= 5; k++) rows.push([1, 40 + k, 64, 40, 2, 2, T(50 + k * 20), 'minecraft:stone', '', HAND]);
  const { presence } = rig(rows);
  const occ = occupancyOf(presence, 1000);
  assert.equal(occ.visits, 2);
  assert.equal(occ.sec, 150, 'seconds 0-100 and 50-150 cover 150 seconds, not 200');
  assert.equal(occ.pct, 15, 'of a 1,000 second log');
  assert.equal(occ.peak, 2, 'two people stand somewhere at once in the overlap');
  assert.equal(occ.peakAt, 50, 'and it starts where the second visit starts');
  assert.deepEqual(occ.perPlayer, [100, 100], 'each one on their own');
});

// The bodies painted as white silhouettes because the tint was 0..255 (the chunk mesher's NORMALIZED u8
// convention) while the body buffer is Float32, where three reads the number as light itself and clips
// anything over 1. A colour bug in a vertex-colour buffer is invisible to every counter, so the range is.
test('a body colour is light in 0..1, not bytes in 0..255', () => {
  for (let p = 0; p < 12; p++) {
    const t = tintOf(p);
    assert.equal(t.length, 3, `player ${p} tint is not rgb`);
    for (const v of t) {
      assert.ok(v >= 0 && v <= 1, `player ${p} tint channel ${v} is outside 0..1 and would clip`);
    }
    assert.ok(Math.max(...t) >= 0.25, `player ${p} tint is too dark to see: ${t}`);
    assert.ok(Math.max(...t) - Math.min(...t) > 0.08, `player ${p} tint is grey, not a hue: ${t}`);
  }
  const rows = [];
  for (let k = 0; k <= 3; k++) rows.push([1, 10 + k, 64, 10, 2, k % 3, T(k * 20), 'minecraft:stone', '', HAND]);
  const { tl, presence, cellOf } = rig(rows);
  const bodies = bodiesHere(tl, presence, 40, { cellOf });
  const g = bodyGeom(bodies);
  assert.ok(g.col.length > 0, 'no colours were written at all');
  for (const v of g.col) assert.ok(v >= 0 && v <= 1, `a body vertex colour is ${v}, which clips to white`);
  assert.ok(new Set(g.col.map((v) => v.toFixed(3))).size >= 3,
    'every vertex carries the same colour, so the body reads as a flat silhouette');
});

// The picture and the click answer ONE question now, so the question needs its own tests: it decides which
// draw group a person lands in as much as who owns a pixel.
test('is anything solid between the eye and this person: the one answer the frame and the click share', () => {
  const grid = (solid) => (x, y, z) => (solid.has(`${x},${y},${z}`) ? C_FULL : C_PASS);
  const at = (x, y, z) => ({ x, y, z, floor: y - 1 });
  const sky = grid(new Set(['0,63,0']));                 // the ground they stand on, nothing else
  assert.equal(bodyWall(sky, at(0, 64, 0), [0, 90, 0]), 'clear',
    'a body under open sky is clear, and the floor under them is not an occluder');
  assert.equal(bodyWall(sky, at(0, 64, 0), [0, 64, 40]), 'clear',
    'and neither is the column they stand in, read sideways');

  const wall = grid(new Set(['0,63,0', '0,64,10', '0,65,10', '0,66,10']));   // a wall 10 out
  assert.equal(bodyWall(wall, at(0, 64, 0), [0, 65, 40]), 'wall',
    'solid ground between the eye and them hides them, and the frame is allowed to agree');

  // A block at their own height one column over is a TUNNEL WALL, not a floor: the mine framing proved it
  // hides them (stone at 10.42 against a body at 9.89), and a height band around body.y used to excuse it.
  const tunnel = grid(new Set(['0,63,0', '1,64,0', '2,64,0', '3,64,0', '4,64,0', '5,64,0']));
  assert.equal(bodyWall(tunnel, at(0, 64, 0), [12, 64, 0]), 'wall',
    'the wall of a tunnel is not the floor of it');

  // Ground nobody fetched is not proof of a wall - the same three-way honesty the seat uses.
  // A wall the eye can see OVER. The middle of a person is behind it and their head is not, and one ray to
  // the chest used to answer 'wall' for a person the frame is plainly showing - in a one-block tunnel that
  // grazed a corner on the way to their middle, hiding somebody standing in plain sight.
  const halfwall = grid(new Set(['0,63,0', '0,64,10', '0,65,10', '0,66,10', '0,67,10']));
  assert.equal(bodyWall(halfwall, at(0, 64, 0), [0, 80, 20]), 'clear',
    'head over the wall, so the person is visible and must draw');
  assert.equal(bodyWall(halfwall, at(0, 64, 0), [0, 66, 20]), 'wall',
    'the same body, eye under the lip: every way in is blocked');

  const held = (x, y, z) => (x >= 4 ? C_PASS : C_UNKNOWN);
  assert.equal(bodyWall(held, at(0, 64, 0), [40, 64, 0]), 'unknown',
    'an unfetched chunk down the line says "not knowable", never "you are hidden"');
  assert.equal(bodyWall((x, y, z) => C_UNKNOWN, at(0, 64, 0), [40, 64, 0]), 'unknown',
    'and a body with no voxels under any part of the way is unknown rather than clear');
  assert.equal(bodyWall(grid(new Set(['0,63,0'])), at(0, 64, 0), [0, 64.6, 0]), 'clear',
    'an eye inside the person answers for them, not against them');
});
