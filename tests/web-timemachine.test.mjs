// M12b: the playhead. The claim under test is that a whole dimension's history can be walked by moving
// an index, not by rebuilding geometry, and that when a rebuild IS needed (a filter change) it is a
// measured cost rather than a guess. Everything here is the pure data layer: no DOM, no three.
import assert from 'node:assert/strict';
import { fakeLog } from './fake-ledger.mjs';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { TL_NO_PLAYER, decodeTimeline, readPack, tlPackCoord } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import {
  ACTION_COLOUR, actionLinear, actionName, beforeClaim, buildTimeQuads, CLAIMS_STAND, claimName,
  filterRows,
  arrivalOfBlock, nextRowForBlock, plainName, playhead, quadAt, rowForBlock, standsAt, voxelKey, voxelRows,
} from '../web/js/ledger-time.mjs';

const T = (s) => 1717174690000 + s * 1000;

// Two chunks, eight rows, in a deliberately shuffled log order: one player's house going up, one block
// placed then broken then placed again, one unattributed row, and one kill with no player.
const FIX = [
  [1, 0, 64, 0, 2, 1, T(100)],     // place, chunk 0,0
  [1, 1, 64, 0, 2, 1, T(110)],
  [1, 1, 64, 0, 3, 1, T(120)],     // break the same block
  [1, 1, 64, 0, 2, 1, T(130)],     // and put it back
  [1, 2, 65, 3, 2, 2, T(140)],     // another player
  [1, 3, 66, 3, 1, 0, T(150)],     // nobody: a change with no player
  [1, 4, 64, 4, 6, 0, T(160)],     // a kill, credited to a source
  [1, 20, 64, 20, 2, 1, T(170)],   // chunk 1,1
];

const fixture = () => {
  const { buf } = buildPack(fakeLog(FIX), 1, 'region', { heightOf: () => 64 });
  const pack = readPack(buf);
  const tl = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
  return { pack, tl };
};

test('the timeline the browser sees is ordered, and the filters keep that order', () => {
  const { tl } = fixture();
  assert.equal(tl.count, 8);
  const all = filterRows(tl);
  assert.equal(all.n, 8);
  // Seconds count from the pack time base, which is the oldest row - so the fixture runs 0..70.
  assert.deepEqual([...all.sec], [0, 10, 20, 30, 40, 50, 60, 70], 'oldest first, once');

  const places = filterRows(tl, { cls: 2 });
  assert.equal(places.n, 5, 'five places: four by one player, one by the other');
  assert.deepEqual([...places.sec], [0, 10, 30, 40, 70], 'a break in the middle does not disturb order');
  assert.equal(places.other, 3);

  const br = filterRows(tl, { cls: 3 });
  assert.deepEqual([...br.sec], [20]);

  // Player 1's rows, and the fact that "nobody" rows are only reachable by asking for anybody: the log's
  // unattributed majority has to stay visible or the picture lies about who built this world.
  const p1 = filterRows(tl, { who: 1 });
  assert.equal(p1.n, 5);
  const p2 = filterRows(tl, { who: 2 });
  assert.deepEqual([...p2.sec], [40], 'base-relative seconds again');
  assert.equal(filterRows(tl, { who: 3 }).n, 0, 'a player with no rows says so');
  assert.equal(filterRows(tl, { who: 1, cls: 2 }).n, 4, 'filters combine');

  const capped = filterRows(tl, { limit: 3 });
  assert.deepEqual([...capped.sec], [0, 10, 20], 'a cap keeps the oldest rows');
  assert.equal(capped.truncated, true);
});

test('one quad per row, in row order, and the playhead is a draw count', () => {
  const { pack, tl } = fixture();
  const all = filterRows(tl);
  const g = buildTimeQuads(tl, pack, all.order);
  assert.equal(g.quads, 8);
  assert.equal(g.verts, 32);
  assert.equal(g.indices, 48);
  assert.equal(g.skipped, 0);
  assert.deepEqual([...g.quadSec], [0, 10, 20, 30, 40, 50, 60, 70],
    'the quad order is the time order, which is the whole trick');
  assert.equal(g.quadSec.length, g.quads, 'one entry per quad, so a draw count cannot overshoot');

  // The index must name the last corner and no further, or a scratch buffer becomes a shape.
  let max = 0;
  for (let i = 0; i < g.indices; i++) max = Math.max(max, g.idx[i]);
  assert.equal(max, g.verts - 1, 'the last index names the last corner');
  assert.ok(g.idx instanceof Uint16Array, '32 corners fit a Uint16 index');

  // The playhead: two years of history resolved by binary search, four rows deep at t=129.
  assert.equal(quadAt(g.quadSec, -1), 0, 'before the first row nothing exists');
  assert.equal(quadAt(g.quadSec, 0), 1, 'at the first row, one quad');
  assert.equal(quadAt(g.quadSec, 29), 3, 'and three by t=29');
  assert.equal(quadAt(g.quadSec, 70), 8);
  assert.equal(quadAt(g.quadSec, 10_000), 8, 'the future is the same as the end');

  // Positions: chunk 0,0 local (0,64,0) is world (0,64,0), and the quad covers that block's footprint.
  const px = (q, c) => g.pos[q * 4 * 3 + c * 3];
  const py = (q, c) => g.pos[q * 4 * 3 + c * 3 + 1];
  const pz = (q, c) => g.pos[q * 4 * 3 + c * 3 + 2];
  assert.deepEqual([px(0, 0), pz(0, 0)], [0, 0]);
  assert.equal(px(0, 2), 1, 'a 1x1 block footprint, not a chunk');
  // The stream is Float32, so the bias lands as it was stored, not as the double that produced it.
  assert.ok(Math.abs(py(0, 0) - 65.02) < 1e-5, `on the block top face at y+1, plus the bias: ${py(0, 0)}`);

  // Winding, checked as a cross product rather than by eye: for triangle (p0,p1,p2) the y component of
  // (p1-p0) x (p2-p0) must be positive, i.e. the face points up at a viewer above it.
  const at2 = (q, c) => [g.pos[q * 12 + c * 3], g.pos[q * 12 + c * 3 + 1], g.pos[q * 12 + c * 3 + 2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cp = sub(at2(0, 1), at2(0, 0)), dp = sub(at2(0, 2), at2(0, 0));
  const cy = cp[2] * dp[0] - cp[0] * dp[2];
  assert.ok(cy > 0, `the face normal points up (${cy})`);

  // Row 7 is in chunk 1,1: cell lookup, not a guess.
  assert.equal(px(7, 0), 16 + 4, 'chunk 1,1 local x 4 = world 20');
  assert.equal(pz(7, 0), 16 + 4);
});

test('a voxel that was broken and rebuilt does not z-fight with itself', () => {
  const { pack, tl } = fixture();
  const g = buildTimeQuads(tl, pack, filterRows(tl).order);
  // Rows 1, 2, 3 are the same block: place, break, place. Three quads, three different heights.
  const y = (q) => g.pos[q * 4 * 3 + 1];
  const x = (q) => g.pos[q * 4 * 3];
  const z = (q) => g.pos[q * 4 * 3 + 2];
  assert.deepEqual([x(1), z(1)], [x(2), z(2)], 'the same block');
  assert.deepEqual([x(2), z(2)], [x(3), z(3)]);
  assert.ok(y(1) < y(2) && y(2) < y(3), 'each repeat sits a little higher');
  assert.ok(y(3) - y(1) < 0.02, 'and the stack stays far under one block');

  // The colour answers "what kind", and it comes from the same table the legend prints. The stream is
  // Float32, so compare with a tolerance rather than bit-for-bit against the double the palette makes.
  const want = (cls) => actionLinear(cls);
  const col = (q) => [g.col[q * 4 * 3], g.col[q * 4 * 3 + 1], g.col[q * 4 * 3 + 2]];
  const near = (a, b, msg) => {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(a[k] - b[k]) < 1e-6, `${msg}: ${a[k]} vs ${b[k]}`);
    }
  };
  near(col(1), want(2), 'a place is the place colour');
  near(col(2), want(3), 'a break is the break colour');
  assert.notDeepEqual(col(1), col(2), 'and they are not the same colour');
  assert.equal(actionName(3), 'break', 'the legend names what the colour means');
  assert.ok(ACTION_COLOUR[2][1] > ACTION_COLOUR[2][0], 'place is green-led, not grey');
});

test('the playhead readout is wall-clock, clamped, and monotonic', () => {
  const { tl } = fixture();
  const at = (s) => playhead(tl, s);
  assert.equal(at(-5).sec, 0, 'the past does not go before the first row');
  assert.equal(at(10_000).sec, tl.spanSec, 'nor past the last');
  assert.equal(at(20).ms, T(120), 'and a second since the base is the log time again');
  assert.equal(at(0).frac, 0);
  assert.equal(at(tl.spanSec).frac, 1);
  assert.equal(at(tl.spanSec).ms, at(tl.spanSec).lastMs);
});

// --------------------------------------------------------------------------- the real overworld

test('an action outside the six named classes has its own bucket, and its own filter', () => {
  // The timeline stores the six named classes as 0..5 and reserves 6 for anything else the log records.
  // Without a filter value for that bucket, "show me the odd ones" would fall through to "show me
  // everything", which is a wrong picture rather than an empty one.
  const log = fakeLog([
    [1, 0, 64, 0, 2, 1, T(0)],      // a place, so the pack has a cell
    [1, 1, 64, 0, 99, 1, T(10)],    // an action id this viewer has no name for
    [1, 2, 64, 0, 98, 0, T(20)],    // and another, with no player
  ]);
  const { buf } = buildPack(log, 1, 'region', { heightOf: () => 64 });
  const pack = readPack(buf);
  const tl = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
  assert.deepEqual([...tl.action], [1, 6, 6], 'the two odd ids land in the reserved bucket');
  const odd = filterRows(tl, { cls: 7 });
  assert.equal(odd.n, 2);
  assert.deepEqual([...odd.sec], [10, 20]);
  assert.equal(odd.other, 1, 'the place is not in it');
  assert.equal(filterRows(tl, { cls: 2 }).n, 1, 'and the six still filter normally');
  assert.equal(filterRows(tl, { cls: 0 }).n, 3, 'any means any, bucket included');
});

test('a row the cell table cannot place is dropped, and the buffers stay exactly the quads', () => {
  // The trap: a skipped row would still have allocated four corners and six indices. Draw the index
  // buffer without a tight draw range and that slack renders as triangles at the world origin.
  const { tl } = fixture();
  const all = filterRows(tl);
  const g = buildTimeQuads(tl, [{ cx: 0, cz: 0 }], all.order);   // only chunk 0,0 exists here
  assert.equal(g.skipped, 1, 'chunk 1,1 is unknown to this table');
  assert.equal(g.quads, all.n - 1);
  assert.equal(g.pos.length, g.quads * 4 * 3, 'no slack in positions');
  assert.equal(g.col.length, g.quads * 4 * 3);
  assert.equal(g.idx.length, g.quads * 6, 'no zero-filled index slack');
  assert.equal(g.quadSec.length, g.quads, 'one second per quad, so the draw count cannot overshoot');
  let max = 0;
  for (let i = 0; i < g.idx.length; i++) max = Math.max(max, g.idx[i]);
  assert.equal(max, g.verts - 1, 'and the last index names the last corner');
  for (let k = 1; k < g.quadSec.length; k++) {
    assert.ok(g.quadSec[k] >= g.quadSec[k - 1], 'still ascending after the gap');
  }
});

test('the baked overworld timeline filters and builds at a measured cost', (t) => {
  const packPath = 'build/ledger/region.ledpack';
  if (!existsSync(packPath)) return t.skip('not baked yet');
  const raw = readFileSync(packPath);
  const pack = readPack(raw);
  const tl = decodeTimeline(raw.subarray(pack.tlBytes[0], pack.tlBytes[1]));
  assert.equal(tl.count, 351531);

  // The filter counts are the numbers the panel has to be able to promise.
  const t0 = performance.now();
  const all = filterRows(tl);
  const filterMs = performance.now() - t0;
  assert.equal(all.n, 351531);
  assert.equal(filterRows(tl, { cls: 2 }).n, 90045, 'places: the Rome-being-built view');
  assert.equal(filterRows(tl, { cls: 3 }).n, 202826, 'breaks outnumber places 2:1');
  assert.equal(filterRows(tl, { who: 1 }).n, 23322, 'playerA');
  assert.equal(filterRows(tl, { who: 2 }).n, 8078, 'playerB');
  let unattributed = 0;
  for (let i = 0; i < tl.count; i++) if (tl.player[i] === TL_NO_PLAYER) unattributed++;
  assert.equal(unattributed, 269358, '77 % of the rows name no player');

  // Rebuild cost, worst case: every row in the dimension, unfiltered.
  const t1 = performance.now();
  const one = filterRows(tl, { who: 1 });
  const small = buildTimeQuads(tl, pack, one.order);
  const smallMs = performance.now() - t1;
  assert.equal(small.quads, 23322);
  assert.equal(small.indices, 23322 * 6);
  assert.ok(small.idx instanceof Uint32Array, '93,288 corners need a 32-bit index');

  const t2 = performance.now();
  const big = buildTimeQuads(tl, pack, all.order);
  const bigMs = performance.now() - t2;
  assert.equal(big.quads, 351531);
  assert.equal(big.skipped, 0, 'every row lands in a chunk the cells table knows');
  assert.deepEqual([big.verts, big.indices], [351531 * 4, 351531 * 6]);

  // A filter change is the only rebuild a scrub does. The plan's bar is 80 ms; the real cost of the
  // whole dimension is what the panel has to warn about, so it is asserted, not assumed.
  console.log(`timeline cost: filter ${filterMs.toFixed(1)} ms, `
    + `build 23,322 rows ${smallMs.toFixed(1)} ms, build 351,531 rows ${bigMs.toFixed(1)} ms, `
    + `${(big.pos.byteLength + big.col.byteLength + big.idx.byteLength) / 1e6} MB of buffers`);
  assert.ok(smallMs < 80, `a single-player rebuild must fit the frame budget (${smallMs.toFixed(1)} ms)`);
  assert.ok(bigMs < 1500, `a whole-dimension rebuild is seconds-scale at worst (${bigMs.toFixed(1)} ms)`);

  // And the playhead itself, at the rate a scrubber actually moves it.
  const t3 = performance.now();
  const counts = [];
  for (let k = 0; k < 1000; k++) counts.push(quadAt(big.quadSec, (k / 999) * tl.spanSec));
  const probeMs = performance.now() - t3;
  assert.equal(counts[0] >= 1, true, 'the oldest instant already has rows');
  assert.equal(counts[999], big.quads, 'and the last one has all of them');
  for (let k = 1; k < counts.length; k++) {
    assert.ok(counts[k] >= counts[k - 1], `draw count went backwards at k=${k}`);
  }
  assert.ok(probeMs < 50, `1,000 playhead moves ${probeMs.toFixed(2)} ms`);
  console.log(`playhead: 1000 draw-range moves in ${probeMs.toFixed(2)} ms, `
    + `rows at the oldest instant ${counts[0]}`);
});

test('an inset tile still names the same block, and the map stops being one sheet of paint', () => {
  // The complaint this answers: a full-block tile per logged change hides the world it describes, so at
  // any zoom the time machine looks like flat green armour over the terrain. Sizing the tile down about
  // its own block centre leaves the block's edge and the seams open. It is geometry, so it costs no fill
  // and no shader, and the playhead arithmetic must not move at all.
  const { pack, tl } = fixture();
  const all = filterRows(tl);
  const full = buildTimeQuads(tl, pack, all.order);
  const in1 = buildTimeQuads(tl, pack, all.order, { shrink: 0.5 });
  assert.equal(in1.quads, full.quads, 'inset changes shape, never how many rows are drawn');
  assert.equal(in1.verts, full.verts);
  assert.equal(in1.indices, full.indices);
  assert.deepEqual([...in1.quadSec], [...full.quadSec], 'the playhead maps to the same quads');
  assert.equal(in1.shrink, 0.5, 'the geometry says what it was asked for');

  const q = (g, c) => [g.pos[c * 3], g.pos[c * 3 + 1], g.pos[c * 3 + 2]];
  // shrink 1 is the old geometry, corner for corner: nothing about the default path moved.
  const one = buildTimeQuads(tl, pack, all.order, { shrink: 1 });
  for (let k = 0; k < 12; k++) assert.ok(Math.abs(one.pos[k] - full.pos[k]) < 1e-6, `corner byte ${k}`);

  // Quad 0 is block (0,64,0): half a block in on each side, and still centred on the block.
  for (const [x, z] of [0, 1, 2, 3].map((c) => [q(in1, c)[0], q(in1, c)[2]])) {
    assert.ok(x >= 0.25 - 1e-6 && x <= 0.75 + 1e-6, `x ${x} stays inside the block`);
    assert.ok(z >= 0.25 - 1e-6 && z <= 0.75 + 1e-6, `z ${z} stays inside the block`);
  }
  const cx = [0, 1, 2, 3].reduce((s, c) => s + q(in1, c)[0], 0) / 4;
  const cz = [0, 1, 2, 3].reduce((s, c) => s + q(in1, c)[2], 0) / 4;
  assert.ok(Math.abs(cx - 0.5) < 1e-6 && Math.abs(cz - 0.5) < 1e-6, 'and centred on it');

  // Winding is what decides whether FrontSide draws it at all, so inset must not flip it.
  const a = q(in1, 0), b = q(in1, 1), c2 = q(in1, 2);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c2[0] - a[0], c2[1] - a[1], c2[2] - a[2]];
  assert.ok(u[2] * v[0] - u[0] * v[2] > 0, 'still faces the sky');
  // Height is untouched: inset is a horizontal argument.
  assert.ok(Math.abs(q(in1, 0)[1] - q(full, 0)[1]) < 1e-6, 'same height as the full tile');
});

test('a card line can rewind the replay to the exact block and moment it names', () => {
  const { pack, tl } = fixture();
  const all = filterRows(tl);
  const g = buildTimeQuads(tl, pack, all.order);
  assert.equal(g.quadRow.length, g.quads, 'one quad, one timeline row');
  for (let q = 0; q < g.quads; q++) {
    assert.equal(tl.sec[g.quadRow[q]], g.quadSec[q], `quad ${q} names its own row`);
  }
  const cellOf = (cx, cz) => {
    for (let i = 0; i < pack.cellCount; i++) {
      const c = pack.cell(i);
      if (c.cx === cx && c.cz === cz) return i;
    }
    throw new Error(`no cell ${cx},${cz}`);
  };
  const c00 = cellOf(0, 0);
  const groups = voxelRows(tl, g.quadRow);
  const block = (x, y, z) => rowForBlock(groups, g.quadSec, c00, tlPackCoord(x, y, z), null);
  assert.equal(block(1, 64, 0).n, 3, 'placed, broken, placed again: three changes to one block');
  assert.equal(block(0, 64, 0).n, 1, 'and a block that was only ever placed');
  assert.equal(rowForBlock(groups, g.quadSec, c00, tlPackCoord(9, 9, 9), 0), null,
    'a block with no logged row answers nothing, rather than the nearest one');

  const seq = groups.get(voxelKey(c00, tlPackCoord(1, 64, 0))).map((q) => g.quadSec[q]);
  assert.deepEqual(seq, [10, 20, 30], 'a block group is in time order');
  // "the last change at or before the moment" is the state a playhead sitting there shows.
  assert.equal(rowForBlock(groups, g.quadSec, c00, tlPackCoord(1, 64, 0), 15).sec, 10);
  assert.equal(rowForBlock(groups, g.quadSec, c00, tlPackCoord(1, 64, 0), 10).sec, 10, 'exact counts');
  const early = rowForBlock(groups, g.quadSec, c00, tlPackCoord(1, 64, 0), 5);
  assert.deepEqual([early.sec, early.before, early.later], [10, 0, 2],
    'older than the block\'s history says so, and says how much later it starts');
  const late = rowForBlock(groups, g.quadSec, c00, tlPackCoord(1, 64, 0), 999);
  assert.deepEqual([late.sec, late.later], [30, 0], 'newer than it lands on the newest');
  // What the card asked for is a quad a draw range can stop at.
  const hit = rowForBlock(groups, g.quadSec, c00, tlPackCoord(1, 64, 0), 15);
  assert.ok(quadAt(g.quadSec, hit.sec) >= hit.quad + 1, 'a draw range at that second draws this quad');
  assert.ok(hit.quad < g.quads);
});

test('a skipped row cannot shift which quad a block points at', () => {
  // The trap this guards: rows and quads are NOT the same numbering once a row is dropped, and a card
  // that answered with a row index would jump the playhead to a different block's moment.
  const { pack, tl } = fixture();
  const all = filterRows(tl);
  const cells = [];
  for (let i = 0; i < pack.cellCount; i++) cells.push(pack.cell(i));
  const c00 = cells.findIndex((c) => c.cx === 0 && c.cz === 0);
  const c11 = cells.findIndex((c) => c.cx === 1 && c.cz === 1);
  cells[c00] = {};                       // unplaceable, and it sits in the MIDDLE of the time order
  const g = buildTimeQuads(tl, cells, all.order);
  assert.equal(g.skipped, 7, 'seven of the eight rows live in the missing chunk');
  assert.equal(g.quads, all.n - 7);
  assert.equal(g.quadRow[0], all.order[7],
    'the one surviving quad is the LAST row: a row index would have named a different moment');
  const groups = voxelRows(tl, g.quadRow);
  const one = rowForBlock(groups, g.quadSec, c11, tlPackCoord(20 & 15, 64, 20 & 15), 0);
  assert.deepEqual([one.n, one.sec, one.quad], [1, 70, g.quads - 1],
    'the surviving row is the last QUAD, not the last row');
  const kill = rowForBlock(groups, g.quadSec, c00, tlPackCoord(4, 64, 4), 0);
  assert.equal(kill, null, 'the dropped chunk\'s blocks are not in the replay, so a click says nothing');
});

/**
 * The pick question. Hovering or clicking has to answer for the moment being watched, and the only evidence
 * for that moment is the log's own rows for that voxel: the mesh under a cursor is the world as it is today
 * (or, inside the replay square, the playhead's), and outside that square a block placed three weeks after
 * the playhead is standing in front of the user while the panel says it is June.
 */
const pickFx = () => {
  const { pack, tl } = fixture();
  const all = filterRows(tl);
  const g = buildTimeQuads(tl, pack, all.order);
  const groups = voxelRows(tl, g.quadRow);
  let c00 = -1;
  for (let i = 0; i < pack.cellCount; i++) {
    const c = pack.cell(i);
    if (c.cx === 0 && c.cz === 0) c00 = i;
  }
  const at = (x, y, z, sec) => standsAt(tl, groups, g.quadRow, g.quadSec, c00, tlPackCoord(x, y, z), sec);
  return { pack, tl, g, groups, c00, at };
};

test('a voxel the filter has no rows for makes no claim, and the pick falls back', () => {
  const { at } = pickFx();
  assert.equal(at(9, 64, 9, 35), null, 'no row, no answer - not "air"');
});

test('a block placed after the moment is not standing at the moment', () => {
  // 1,64,0 in the fixture: place at 10, break at 20, place again at 30.
  const { at } = pickFx();
  const early = at(1, 64, 0, 5);
  assert.equal(early.stands, 0, 'before its only placements: nothing stands there');
  assert.deepEqual([early.starts.sec, early.starts.cls], [10, 1], 'and the reason names the first claim');
  assert.equal(claimName(early.starts.cls), 'place');
  assert.equal(at(1, 64, 0, 10).stands, 1, 'at the placement it stands');
  assert.equal(at(1, 64, 0, 15).stands, 1, 'and after it');
});

test('a block broken before the moment is not standing either, and says what comes next', () => {
  const { at } = pickFx();
  const gone = at(1, 64, 0, 25);
  assert.equal(gone.stands, 0, 'the deciding row is the break at 20');
  assert.equal(gone.sec, 20, 'the row that decided it');
  assert.deepEqual([gone.starts.sec, gone.starts.cls], [30, 1], 'the next claim is the place at 30');
  assert.equal(at(1, 64, 0, 35).stands, 1, 'placed again, so it stands again');
  assert.equal(at(1, 64, 0, 35).later, 0, 'and nothing is left ahead of the moment');
});

test('a change or a later break proves the block stood before the log first spoke of it', () => {
  const { at, tl, g } = pickFx();
  // 3,66,3 has one `change` row at sec 50: a state swap is a block that is there, so the block stood even
  // at a moment the log has never looked at. A place (1,64,0 at sec 10) is the opposite case: what stood
  // under a placement is only knowable when the log named the block it replaced.
  const chg = at(3, 66, 3, 5);
  assert.equal(chg.stands, 1, 'older than its only row, but that row changed a standing block');
  assert.deepEqual([chg.starts?.sec, chg.starts?.cls], [50, 0], 'and it still says when the log noticed it');
  const oldest = g.quadRow[0];
  assert.equal(tl.action[oldest], 1, 'the oldest row in the fixture is a placement');
  assert.equal(tl.was?.[oldest] ?? 0, 0, 'and it names no block underneath');
  assert.equal(beforeClaim(tl, oldest), 0, 'so a moment before a placement reads as nothing standing');
});

test('an action that says nothing about the voxel says nothing, rather than guessing air', () => {
  const { at } = pickFx();
  // 4,64,4 is a kill (byte 5) at sec 60: an entity dying in a doorway is not a claim about the doorway.
  assert.equal(at(4, 64, 4, 65).stands, null, 'a kill leaves the block question to the chunks');
  assert.equal(at(4, 64, 4, 65).cls, 5, 'but it still names the row that answers nothing');
  assert.deepEqual(CLAIMS_STAND, [1, 1, 0, null, null, null, null],
    'change/place stand, break does not, containers and kills make no claim');
});

test('the next claim search is the mirror of the deciding-row search', () => {
  const { groups, g, c00 } = pickFx();
  const key = tlPackCoord(1, 64, 0);
  assert.deepEqual([nextRowForBlock(groups, g.quadSec, c00, key, 0)?.sec,
    nextRowForBlock(groups, g.quadSec, c00, key, 11)?.sec,
    nextRowForBlock(groups, g.quadSec, c00, key, 31)], [10, 20, null],
  'at or after: the first one, the one after 11, and nothing after the last');
  assert.equal(nextRowForBlock(groups, g.quadSec, c00, tlPackCoord(9, 64, 9), 0), null,
    'a voxel with no rows still answers nothing');
});

/**
 * The name-aware pick. "Does a block stand in this voxel" is the voxel's question; a cursor is pointing at
 * one particular block, and the log can name that block's own arrival. This is the case that kept reading
 * as a bug: the shell/LOD layers cannot be re-cut by the replay, so a wall the playhead has not built yet
 * is painted on screen, and the pick agreed with the picture.
 */
const namedFx = () => {
  const rows = [
    [1, 9, 64, 9, 2, 1, T(0), 'minecraft:grass_block', ''],          // rel 0: older ground, nobody's house
    [1, 5, 64, 5, 2, 1, T(100), 'minecraft:deepslate_bricks', 'minecraft:deepslate'], // rel 100: wall over ground
    [1, 6, 64, 6, 3, 1, T(200), 'minecraft:air', 'minecraft:stone'],  // rel 200: a break names what left
    [1, 7, 64, 7, 2, 1, T(300), 'minecraft:oak_stairs', ''],          // rel 300: stairs, nothing recorded under
    [1, 8, 64, 8, 1, 1, T(400), 'minecraft:lever', 'minecraft:lever'],// rel 400: a state swap of a standing block
  ];
  const { buf } = buildPack(fakeLog(rows), 1, 'region', { heightOf: () => 64 });
  const pack = readPack(buf);
  const tl = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
  const all = filterRows(tl);
  const g = buildTimeQuads(tl, pack, all.order);
  const groups = voxelRows(tl, g.quadRow);
  let c00 = -1;
  for (let i = 0; i < pack.cellCount; i++) { const c = pack.cell(i); if (c.cx === 0 && c.cz === 0) c00 = i; }
  const at = (x, y, z, sec, name) => standsAt(tl, groups, g.quadRow, g.quadSec, c00,
    tlPackCoord(x, y, z), sec, name);
  return { pack, tl, g, groups, c00, at };
};

test('the block a cursor is on is refused when the log says it arrives later', () => {
  const { at, tl } = namedFx();
  const early = at(5, 64, 5, 50, 'minecraft:deepslate_bricks');
  assert.equal(early.stands, 0, 'the wall is placed at second 100, so it does not stand at 50');
  assert.equal(early.arrival.sec, 100, 'and the refusal names the placement of THAT block, not just any row');
  assert.equal(early.arrival.cls, 1, 'a placement is the arrival: a change swaps a block that already stood');
  assert.equal(tl.nameOf(early.arrival.row), 'minecraft:deepslate_bricks', 'the row it quotes is the block itself');
  assert.deepEqual([early.starts.sec, early.starts.cls], [100, 1], 'and the hover sentence can use the same row');
  assert.equal(at(5, 64, 5, 100, 'minecraft:deepslate_bricks').stands, 1,
    'at the placement second it stands: the row is at or before the moment, exactly as the decals draw it');
  assert.equal(at(5, 64, 5, 150, 'minecraft:deepslate_bricks').stands, 1, 'and after it');
  assert.equal(at(5, 64, 5, 150, 'minecraft:deepslate_bricks').arrival, undefined,
    'a standing answer carries no arrival, so a card cannot print a contradiction');
});

test('a name that merely differs is not evidence of absence', () => {
  const { at } = namedFx();
  // The place at second 100 replaced deepslate. Ask about the deepslate, or about a block the voxel's rows
  // never name: neither has an arrival row, so the verdict stays what the name-blind rules say (unknown -
  // the log recorded a block underneath but not when IT arrived). Inventing a refusal here would hide a
  // floor that really stands, and would look identical to an unlogged plugin edit.
  assert.equal(at(5, 64, 5, 50, 'minecraft:deepslate').stands, null, 'the block under the wall: unknown');
  assert.equal(at(5, 64, 5, 50, 'minecraft:dirt').stands, null, 'a block nobody logged here: unknown');
  assert.equal(at(5, 64, 5, 50, 'minecraft:dirt').arrival, undefined, 'and no arrival is quoted for it');
  assert.equal(at(5, 64, 5, 50).stands, null, 'with no name in the question, the old answer stands');
});

test('a properties-suffixed payload key matches the log\'s plain block name', () => {
  const { at } = namedFx();
  // The chunks spell a state `minecraft:oak_stairs|facing=north`, the ledger spells it `minecraft:oak_stairs`.
  // Compare the strings as they arrive and every pick becomes "that block is not here", i.e. an outline
  // that never shows.
  assert.equal(plainName('minecraft:oak_stairs|facing=north'), 'minecraft:oak_stairs');
  assert.equal(plainName('minecraft:stone'), 'minecraft:stone', 'no property, nothing to strip');
  assert.equal(plainName(null), null, 'no name is still no name');
  const p = at(7, 64, 7, 150, 'minecraft:oak_stairs|facing=north');
  assert.equal(p.stands, 0, 'the stairs arrive at second 300, props or no props');
  assert.equal(p.arrival.sec, 300);
});

test('a later break is not an arrival, and still proves the block stood', () => {
  const { at } = namedFx();
  // 6,64,6 has one break at second 200 (the log names the block that LEFT, `minecraft:stone`). At second 50
  // the honest answer for stone is that it stood there until someone took it, and no placement contradicts
  // that, so the name-aware rule must not turn the break into a refusal.
  const s = at(6, 64, 6, 50, 'minecraft:stone');
  assert.equal(s.stands, 1, 'the log\'s first word is that this block left: it was standing');
  assert.equal(s.arrival, undefined, 'a break is not a placement');
  assert.equal(at(8, 64, 8, 150, 'minecraft:lever').stands, 1,
    'a change at second 400 is a state swap of a block that already stood');
});

test('the arrival search starts strictly after the moment it was asked about', () => {
  const { at, tl, g, groups, c00 } = namedFx();
  const key = tlPackCoord(5, 64, 5);
  assert.equal(arrivalOfBlock(tl, groups, g.quadRow, g.quadSec, c00, key, 0, 'minecraft:deepslate_bricks').sec, 100,
    'the wall arrives at second 100');
  assert.equal(arrivalOfBlock(tl, groups, g.quadRow, g.quadSec, c00, key, 100, 'minecraft:deepslate_bricks'), null,
    'a placement AT the playhead second is already drawn, so it is not "comes later"');
  assert.equal(arrivalOfBlock(tl, groups, g.quadRow, g.quadSec, c00, key, 0, null), null,
    'no name in the question asks nothing');
  assert.equal(arrivalOfBlock(tl, groups, g.quadRow, g.quadSec, c00, tlPackCoord(9, 64, 9), 0, 'minecraft:grass_block'),
    null, 'the grass_block placement at second 0 is not after second 0');
  assert.equal(at(5, 64, 5, 100, 'minecraft:deepslate_bricks').stands, 1, 'same fact through the pick');
});

test('a refusal quotes the placement of the block it is refusing', () => {
  // "Not there at the playhead" is only useful if it says when the block you pointed at arrives, and the
  // row it quotes has to be that block's own placement, not the voxel's first row of any kind.
  const { at } = namedFx();
  const early = at(5, 64, 5, 50, 'minecraft:deepslate_bricks');
  assert.deepEqual([early.arrival.sec, early.starts.sec, early.starts.cls], [100, 100, 1],
    'the refusal and the "when does it start" line quote the same placement');
  const gone = at(5, 64, 5, 150, 'minecraft:deepslate_bricks');
  assert.equal(gone.stands, 1, 'at second 150 the wall stands: its placement at 100 is behind the moment');
  assert.equal(gone.arrival, undefined, 'and a standing answer carries no arrival to contradict it');
});
