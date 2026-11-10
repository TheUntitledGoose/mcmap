// M15.2: shared/ghosts.mjs - presence inferred from hand-attributed rows only.
//
// The timelines here are REAL: a fake log goes through the same pack writer and decoder the bake uses,
// so the source byte, the player byte and the row ordering are the shipped ones rather than a shape the
// test invented. That matters most for the honesty cases, where the whole point is which rows the code is
// NOT allowed to treat as a body.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPack } from '../server/ledger-pack.mjs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import {
  RUN_GAP_SEC, SEAT_LOOK, handRowAt, handRows, presenceOf, bodiesAt, visitOfK, seatOf, trackOf, nearestVisit,
} from '../shared/ghosts.mjs';
import { fakeLog } from './fake-ledger.mjs';
import { cutTimeline } from './tl-cut.mjs';

const T = (sec) => 1717174690000 + sec * 1000;      // the same base the shipped pack uses
const HAND = 'player';
// A pack's timeline counts seconds from ITS OWN first row, so the earliest row of a fixture sits at
// second 0 and every "at second N" below is relative to that. The page's playhead speaks the same thing.

/** fake rows -> a decoded timeline + the cell table, i.e. what the page actually holds. */
function rig(rows) {
  const L = fakeLog(rows);
  const { buf } = buildPack(L, 1, 'region');
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  return { tl, P, worldOf: (ci) => P.cell(ci) };
}

/** The same, but hand back the raw timeline bytes so a test can cut them to an older version. */
function slice(rows) {
  const { buf } = buildPack(fakeLog(rows), 1, 'region');
  const P = readPack(buf);
  return buf.subarray(P.tlBytes[0], P.tlBytes[1]);
}

test('a hand row is presence and a creeper row with the same name is not', () => {
  const { tl, worldOf } = rig([
    [1, 5, 64, 5, 2, 1, T(100), 'minecraft:stone', '', HAND],
    [1, 900, 64, 900, 3, 1, T(120), 'minecraft:stone', '', 'creeper'],   // same player, not their hand
  ]);
  assert.equal(tl.count, 2);
  assert.equal(tl.byHand(0), true, 'the source table knows a hand row');
  assert.equal(tl.byHand(1), false, 'and knows a creeper blast is not one');
  const pres = presenceOf(tl, { worldOf });
  assert.equal(pres.handRows, 1, 'one row of body evidence, not two');
  assert.equal(pres.visits, 1);
  const bodies = bodiesAt(pres, 130);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].row, 0, 'the body stands at the hand row');
  assert.equal(bodies[0].absent, null);
  assert.equal(handRows(tl).length, 1);
  assert.equal(handRowAt(tl, 1), false);
});

test('a row with no player on it is nobody', () => {
  const { tl, worldOf } = rig([[1, 5, 64, 5, 2, 0, T(100), 'minecraft:stone', '', HAND]]);
  assert.equal(presenceOf(tl, { worldOf }).players.length, 0, 'unattributed places nobody');
});

test('silence longer than the cut ends a visit, and the body goes with it', () => {
  const rows = [
    [1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND],
    [1, 6, 64, 5, 2, 1, T(10), 'minecraft:stone', '', HAND],
    [1, 400, 64, 700, 2, 1, T(400), 'minecraft:stone', '', HAND],
    [1, 401, 64, 700, 2, 1, T(410), 'minecraft:stone', '', HAND],
  ];
  const { tl, worldOf } = rig(rows);
  const pres = presenceOf(tl, { worldOf });
  assert.equal(pres.gap, RUN_GAP_SEC);
  assert.equal(pres.visits, 2, 'two visits, not one eight-hour session');
  const p = pres.players[0];
  assert.deepEqual(p.visits.map((v) => [v.t0, v.t1, v.n]), [[0, 10, 2], [400, 410, 2]]);
  assert.deepEqual(p.visits.map((v) => v.across), [1, 1], 'both visits move the hand one block');
  assert.deepEqual(p.visits.map((v) => v.cells), [1, 1], 'and stay in one chunk each');
  assert.equal(bodiesAt(pres, 5)[0].row, 0);
  assert.equal(bodiesAt(pres, 20)[0].absent, 'gap', '20 s after the last action, still inside the cut');
  assert.equal(bodiesAt(pres, 399)[0].absent, 'gap');
  assert.equal(bodiesAt(pres, 399)[0].age, 389);
  assert.equal(bodiesAt(pres, 405)[0].absent, null, 'and back inside the next visit');
  assert.equal(bodiesAt(pres, 405)[0].row, 2);
  assert.equal(visitOfK(p, 3), p.visits[1], 'the last row belongs to the second visit');
  assert.equal(visitOfK(p, 1), p.visits[0]);
});

test('a hole inside a visit places nobody when the body question is tighter than the visit', () => {
  const { tl, worldOf } = rig([
    [1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND],
    [1, 5, 64, 5, 2, 1, T(30), 'minecraft:stone', '', HAND],
    [1, 5, 64, 5, 2, 1, T(270), 'minecraft:stone', '', HAND],     // 240 s of silence: still ONE visit at 300
  ]);
  const pres = presenceOf(tl, { worldOf });
  assert.equal(pres.visits, 1, 'a 240 s gap with a 300 s cut is one visit');
  assert.equal(bodiesAt(pres, 100)[0].absent, null, 'asked at the visit cut, they are still standing there');
  const tight = bodiesAt(pres, 100, { gap: 120 });
  assert.equal(tight[0].absent, 'gap', 'asked tighter, the 240 s hole shows up and the body goes');
  assert.equal(tight[0].age, 70, 'and the answer quotes how long since the last action');
});

test('before a player acts, and a while after they stop, the log says which', () => {
  const { tl, worldOf } = rig([
    [1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND],       // one player from the first second
    [1, 9, 64, 9, 2, 2, T(1000), 'minecraft:stone', '', HAND],    // another arrives 1000 s in
    [1, 9, 64, 9, 2, 2, T(1010), 'minecraft:stone', '', HAND],
  ]);
  const pres = presenceOf(tl, { worldOf });
  const early = bodiesAt(pres, 100);
  assert.equal(early.length, 2, 'both players are answered for, even the one with no rows yet');
  const late = early.find((b) => b.player === 1);
  assert.deepEqual([late.k, late.row, late.absent], [-1, -1, 'ahead'], 'their evidence is all in the future');
  assert.equal(early.find((b) => b.player === 0).absent, null, '100 s after an action is inside the cut');
  assert.equal(bodiesAt(pres, 400).find((b) => b.player === 0).absent, 'gap', '400 s after is not');
  const at = bodiesAt(pres, 1010).find((b) => b.player === 1);
  assert.equal(at.absent, null, 'at the row itself the body is there');
  assert.equal(at.age, 0);
  assert.equal(bodiesAt(pres, 1010 + RUN_GAP_SEC).find((b) => b.player === 1).absent, null,
    'and for the cut window afterwards');
  assert.equal(bodiesAt(pres, 1011 + RUN_GAP_SEC).find((b) => b.player === 1).absent, 'gap', 'then it is over');
  assert.equal(pres.first, 0);
  assert.equal(pres.last, 1010, 'the window ends at the last hand row, not the last log row');
  assert.equal(pres.spanSec, 1010);
});

test('presence quotes the window the log can name a body in, and the nearest one', () => {
  const { tl, worldOf } = rig([
    [1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND],
    [1, 9, 64, 9, 2, 1, T(30), 'minecraft:stone', '', HAND],
    [1, 600, 64, 600, 2, 2, T(90000), 'minecraft:stone', '', HAND],
  ]);
  const pres = presenceOf(tl, { worldOf });
  assert.equal(pres.players.length, 2);
  assert.equal(pres.first, 0, 'the earliest hand row across all players');
  assert.equal(pres.last, 90000);
  const near = nearestVisit(pres, 50000);
  assert.equal(near.inside, false);
  assert.equal(near.dist, 90000 - 50000, 'the 50,000 s hole is the distance to quote');
  assert.equal(near.visit.t0, 90000);
  assert.equal(nearestVisit(pres, 10).inside, true, 'and a second inside a visit says so');
});

test('the seat walks down from the acted block and stands the body on the first solid thing', () => {
  // A place: today's payload still holds the block they placed at y 66, over ground topping out at 65.
  const placed = rig([[1, 5, 66, 5, 2, 1, T(0), 'minecraft:dirt', '', HAND]]);
  const got = seatOf(placed.tl, 0, {
    solid: (x, y, z) => x === 5 && z === 5 && y <= 66, worldOf: placed.worldOf,
  });
  assert.equal(got.seat, 'ground');
  assert.equal(got.floor, 66, 'the block they placed supports them');
  assert.equal(got.y, 67, 'feet on top of it');
  assert.deepEqual([got.x, got.z], [5, 5], 'cell-local x/z stays in the chunk it came from');
  // A break: the payload there is air now, so the floor is the block underneath and the feet land in the
  // space the mined block used to fill.
  const broke = rig([[1, 5, 66, 5, 3, 1, T(0), 'minecraft:stone', '', HAND]]);
  const back = seatOf(broke.tl, 0, {
    solid: (x, y, z) => x === 5 && z === 5 && y <= 65, worldOf: broke.worldOf,
  });
  assert.equal(back.seat, 'ground');
  assert.equal(back.floor, 65, 'the mined block is gone from the payload, so its neighbour supports');
  assert.equal(back.y, 66);
  const dry = seatOf(placed.tl, 0, { solid: () => false, worldOf: placed.worldOf });
  assert.equal(dry.seat, 'float', 'nothing within the look distance supports a body, and it says so');
  assert.equal(dry.floor, null);
  assert.equal(dry.y, 67, 'the fallback is one block above the acted block, named as a guess');
  const blind = seatOf(broke.tl, 0, { worldOf: broke.worldOf });
  assert.equal(blind.seat, 'near', 'no voxel data here: only the action is a clue');
  assert.ok(SEAT_LOOK > 0, 'and the search is bounded, not "scan to the bottom of the world"');
});

test('a track keeps its shape and always ends where the player left', () => {
  const rows = [];
  for (let k = 0; k < 40; k++) rows.push([3, 40 + k, 64, 90, 2, 1, T(k * 5), 'minecraft:stone', '', HAND]);
  const L = fakeLog(rows);
  const { buf } = buildPack(L, 3, 'DIM1');
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  const worldOf = (ci) => P.cell(ci);
  const pres = presenceOf(tl, { worldOf });
  const p = pres.players[0];
  assert.equal(p.visits.length, 1, '200 s of acting with a 5 s beat is one visit');
  const full = trackOf(tl, p, p.visits[0], { worldOf });
  assert.equal(full.length, 40);
  assert.equal(full[0].x, 40, 'chunk 2 holds local x 8 -> world 40');
  const thin = trackOf(tl, p, p.visits[0], { max: 8, worldOf });
  assert.equal(thin.length, 8, 'thinned to the ceiling, by stride rather than by truncation');
  assert.equal(thin[thin.length - 1].row, p.rows[p.rows.length - 1], 'and the exit is one of them');
  assert.ok(thin[1].x - thin[0].x > 1, 'the stride spreads the points out');
  assert.equal(trackOf(tl, p, p.visits[0], { max: 1, worldOf }).length, 1, 'a ceiling of 1 is honoured');
});

test('two players in one dimension are two bodies, and a filter asks for one', () => {
  const { tl, worldOf } = rig([
    [1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND],
    [1, 9, 64, 9, 2, 2, T(0), 'minecraft:stone', '', HAND],
    [1, 9, 64, 9, 3, 2, T(4000), 'minecraft:stone', '', 'tnt'],   // not a hand, not presence
  ]);
  const all = presenceOf(tl, { worldOf });
  assert.equal(all.players.length, 2);
  assert.equal(all.handRows, 2);
  assert.deepEqual(bodiesAt(all, 10).map((b) => [b.player, b.absent]), [[0, null], [1, null]]);
  const one = presenceOf(tl, { worldOf, who: 1 });
  assert.equal(one.players.length, 1);
  assert.equal(one.players[0].player, 1);
  assert.equal(bodiesAt(one, 10).length, 1, 'a filtered presence answers for one player only');
  assert.equal(bodiesAt(one, 10)[0].row, 1);
});

test('a v4 timeline is required for presence: an older pack refuses to place anybody', () => {
  // An un-rebaked pack carries no source column, and "we cannot tell" must not degrade into "assume the
  // named player caused it": that is the 166-block lie the source byte exists to prevent.
  const v3 = decodeTimeline(cutTimeline(slice([[1, 5, 64, 5, 2, 1, T(0), 'minecraft:stone', '', HAND]]), 3));
  assert.equal(v3.version, 3);
  assert.equal(v3.player[0], 0, 'the name is still there');
  assert.equal(v3.byHand(0), false, 'but the pack cannot claim a hand caused it');
  assert.equal(presenceOf(v3, { worldOf: () => ({ cx: 0, cz: 0 }) }).players.length, 0,
    'so the presence layer is empty rather than guessing from the name');
});
