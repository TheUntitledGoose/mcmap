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
  ACTION_COLOUR, actionLinear, actionName, buildTimeQuads, filterRows, playhead, quadAt,
  rowForBlock, voxelKey, voxelRows,
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
