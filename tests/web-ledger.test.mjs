// The overlay's data half: the filter, the heat scale, the geometry, and the wording of an evidence
// line. Everything here is the part that decides what the log is *claiming* - the page only turns the
// numbers into a mesh and a card - so it is tested without a browser.
//
// Packs are built with the real writer over a made-up log, so a layout change in shared/ledger-pack.mjs
// breaks this file rather than silently feeding the overlay nonsense.
import test from 'node:test';
import { fakeLog } from './fake-ledger.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildPack } from '../server/ledger-pack.mjs';
import { readPack } from '../shared/ledger-pack.mjs';
import { ACTION_NAME, ACTION_BLOCK_TOUCH } from '../shared/ledger-format.mjs';
import {
  buildHeatQuads, buildPins, classColumn, collectCells, heatLinear, heatRamp, heatScale,
  LEDGER_CLASSES, nearRows, playerBit, rankCells, rowLine, summarizeRows, timeAgo, formatTime,
} from '../web/js/ledger-view.mjs';

const T = (s) => 1717174690000 + s * 1000;

// A log is only ever read through accessors, so a test log is built the same way (see
// tests/ledger-pack.test.mjs for the same helper).
// One row per chunk, at a chosen chunk coordinate, with a ground height so the geometry has somewhere
// to stand. `[[cx, cz, actionId, playerId]]`.
const packOf = (spec, heightOf = (cx, cz) => 70 + ((cx + cz) & 7)) => {
  const L = fakeLog(spec.map(([cx, cz, actionId, playerId], k) =>
    [1, cx * 16 + 3, 64, cz * 16 + 3, actionId, playerId, T(k + 1)]));
  return readPack(buildPack(L, 1, 'region', { heightOf }).buf);
};

test('the class names come from the log, not from a guess in the viewer', () => {
  assert.deepEqual(LEDGER_CLASSES.map((c) => c.name),
    [1, 2, 3, 4, 5, 6].map((id) => ACTION_NAME[id]));
  assert.equal(classColumn(2), 1, 'block-place is the second count column');
  assert.equal(classColumn(0), -1, 'no filter means every kind of action summed');
  assert.equal(classColumn(99), -1, 'an unknown class cannot read past the table');
  assert.equal(playerBit(1), 1);
  assert.equal(playerBit(33), 0, 'a player id past the mask matches no cell rather than every cell');
});

test('the filter reads counts, the mask, and the floor together', () => {
  const P = packOf([
    [0, 0, 2, 1], [0, 0, 2, 2], [0, 0, 3, 2],   // chunk 0,0: 2 places + 1 break, two players
    [4, 0, 3, 0],                               // chunk 4,0: one break by fire, not a player
    [8, 0, 1, 3],                               // chunk 8,0: one change by player 3
  ]);
  const all = collectCells(P);
  assert.equal(all.cells.length, 3);
  assert.equal(all.max, 3, 'the busiest chunk holds three of the rows');
  assert.deepEqual(all.cells.map((c) => c.n).sort((a, b) => b - a), [3, 1, 1]);

  const places = collectCells(P, { cls: 2 });
  assert.deepEqual(places.cells.map((c) => [c.cx, c.cz, c.n]), [[0, 0, 2]]);

  const p2 = collectCells(P, { player: 2 });
  assert.deepEqual(p2.cells.map((c) => [c.cx, c.cz, c.n]), [[0, 0, 3]],
    'a player filter counts every kind of action that player did in the chunk');

  const noplayers = collectCells(P, { player: 9 });
  assert.deepEqual(noplayers.cells, [], 'a player nobody has answers with nothing');

  const floor = collectCells(P, { minN: 2 });
  assert.deepEqual(floor.cells.map((c) => [c.cx, c.cz]), [[0, 0]]);
  assert.equal(floor.dropped, 2, 'the single-row specks are counted, not silently vanished');

  // Times come back as absolute milliseconds, which is what a card has to print.
  const c0 = all.cells.find((c) => c.cx === 0);
  assert.ok(c0.t0 < c0.t1 && c0.t0 > 1_000_000_000_000, 't0/t1 are epoch ms');
});

test('a chunk with no baked ground is named, not drawn at sea level', () => {
  const P = packOf([[0, 0, 2, 1], [4, 0, 3, 1]], (cx) => (cx === 0 ? 64 : null));
  const got = collectCells(P);
  assert.equal(got.noHeight, 1);
  const built = buildHeatQuads(got.cells);
  assert.equal(built.quads, 1, 'only the chunk with ground is drawn');
  assert.equal(built.skipped, 1, 'and the missing one is reported as a fact about the bake');
});

test('the heat scale is a log scale, because 4,254 and 1 live in the same picture', () => {
  assert.equal(heatScale(0, 100), 0, 'nothing to show is not a colour');
  assert.equal(heatScale(100, 100), 1);
  // The overworld's busiest touched chunk holds 4,254 rows and its median holds 3. On a linear ramp
  // a lone row would be 0.07 % of the way up the ramp - invisible. On a log ramp it is a shade.
  assert.ok(heatScale(1, 4254) > 0.05, 'one row still gets a colour next to 4,254');
  assert.ok(heatScale(1, 4254) < heatScale(16, 4254));
  let prev = -1;
  for (const n of [1, 2, 4, 8, 16, 64, 256, 1024, 4254]) {
    const t = heatScale(n, 4254);
    assert.ok(t > prev, `${n} must be louder than the count before it`);
    prev = t;
  }
  assert.ok(heatScale(99999, 4254) === 1, 'a count past the ramp top clamps');
});

test('the ramp is clamped, monotonic in hotness, and linear-light when asked for', () => {
  assert.deepEqual(heatRamp(-1), heatRamp(0));
  assert.deepEqual(heatRamp(2), heatRamp(1));
  const cold = heatRamp(0), hot = heatRamp(1);
  assert.ok(cold[2] > cold[0], 'the cold end is blue-ish');
  assert.ok(hot[0] > hot[2], 'the hot end is red-ish');
  const lin = heatLinear(4254, 4254);
  assert.ok(lin[0] > 0.9, 'the hot end converts to near-full linear red');
  assert.ok(lin[0] > heatLinear(1, 4254)[0]);
});

test('the overlay is four corners and six indices a chunk, facing up', () => {
  const P = packOf([[0, 0, 2, 1], [1, 0, 2, 1], [2, 0, 3, 1]], () => 65);
  const got = collectCells(P);
  const g = buildHeatQuads(got.cells, { bias: 0.6 });
  assert.equal(g.quads, 3);
  assert.equal(g.verts, 12, 'one quad per touched chunk, not one per row');
  assert.equal(g.indices, 18);
  assert.equal(g.pos.length, 36);
  assert.equal(g.col.length, 36, 'the colour rides per corner so one material draws the lot');
  assert.ok(g.idx instanceof Uint16Array, '12 corners fit a Uint16 index');
  let maxIdx = 0;
  for (const i of g.idx) maxIdx = Math.max(maxIdx, i);
  assert.equal(maxIdx, g.verts - 1, 'the last index has to name the last corner, not a middle one');
  for (let q = 0; q < g.quads; q++) {
    assert.deepEqual(Array.from(g.idx.slice(q * 6, q * 6 + 6)), [4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3],
      `quad ${q} uses its own four corners`);
  }

  // First quad: a 16x16 square over chunk 0,0, standing 0.6 above its ground. Positions are Float32,
  // so 65.6 is not exactly representable and the comparison has to be a tolerance.
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.abs(g.pos[k * 3 + 1] - 65.6) < 1e-4, `corner ${k} sits on the ground plus the bias`);
  }
  const xs = [0, 1, 2, 3].map((k) => g.pos[k * 3]);
  const zs = [0, 1, 2, 3].map((k) => g.pos[k * 3 + 2]);
  assert.equal(Math.max(...xs) - Math.min(...xs), 16);
  assert.equal(Math.max(...zs) - Math.min(...zs), 16);

  // Winding: (b-a) x (c-a) must point at +Y, so the quad faces the sky.
  const a = [g.pos[0], g.pos[1], g.pos[2]];
  const b = [g.pos[3], g.pos[4], g.pos[5]];
  const c = [g.pos[6], g.pos[7], g.pos[8]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ny = u[2] * v[0] - u[0] * v[2];
  assert.ok(ny > 0, `triangle winding faces up (ny ${ny})`);

  // Every quad of one colour: the ramp is per chunk, so a corner cannot disagree with its own quad.
  for (let q = 0; q < g.quads; q++) {
    for (let k = 1; k < 4; k++) {
      assert.deepEqual(
        [g.col[(q * 4 + k) * 3], g.col[(q * 4 + k) * 3 + 1], g.col[(q * 4 + k) * 3 + 2]],
        [g.col[q * 12], g.col[q * 12 + 1], g.col[q * 12 + 2]]);
    }
  }
});

test('a world of touched chunks needs a 32-bit index', () => {
  // The overworld really does have 20,322 touched chunks, so this is not a hypothetical: 16,384
  // corners is the point where a Uint16 index stops being able to name them.
  const spec = [];
  for (let i = 0; i < 16384; i++) spec.push([i, 0, 2, 1]);
  const got = collectCells(packOf(spec));
  const g = buildHeatQuads(got.cells);
  assert.equal(g.quads, 16384);
  assert.equal(g.verts, 65536);
  assert.ok(g.idx instanceof Uint32Array, 'the index has to reach corner 65,535 and past it');
  assert.equal(g.idx[g.idx.length - 1], 65535, 'and it actually does name it');
});

test('the pins are cages, and only where there is ground to stand them on', () => {
  const P = packOf([[0, 0, 2, 1], [4, 0, 2, 1]], (cx) => (cx === 0 ? 60 : null));
  const got = collectCells(P);
  const top = rankCells(got.cells, 12);
  const pin = buildPins(top, { height: 40 });
  assert.equal(pin.verts, 8, 'four corner lines is eight endpoints');
  assert.equal(pin.pos.length, pin.verts * 3, 'and the buffer is trimmed to them, not padded with zeros');
  let minY = Infinity, maxY = -Infinity;
  for (let k = 0; k < pin.verts; k++) {
    const y = pin.pos[k * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  assert.ok(maxY - minY >= 39, 'a pin is a column, tall enough to see from a kilometre away');
});

test('rankCells answers "where is the action", loudest first and stably', () => {
  const cells = [{ cx: 1, cz: 1, n: 5 }, { cx: 2, cz: 2, n: 90 }, { cx: 3, cz: 3, n: 5 }, { cx: 4, cz: 4, n: 40 }];
  assert.deepEqual(rankCells(cells, 3).map((c) => c.n), [90, 40, 5]);
  const ranked = rankCells(cells, 4);
  assert.deepEqual(ranked.map((c) => c.n), [90, 40, 5, 5]);
  assert.deepEqual(ranked.slice(2).map((c) => c.cx), [1, 3],
    'a tie is broken by position, so the same query gives the same tour every time');
  assert.equal(rankCells(cells, 99).length, 4);
});

// ---- the point query -------------------------------------------------------------------------

const ROWS = [
  { row: 1, t: T(10), x: 10, y: 64, z: 20, cls: 2, block: 'minecraft:chest', player: 'playerA', source: 'player' },
  { row: 2, t: T(20), x: 10, y: 64, z: 20, cls: 3, block: 'minecraft:chest', player: '', source: 'explosion' },
  { row: 3, t: T(30), x: 11, y: 64, z: 20, cls: 1, block: 'minecraft:furnace', player: 'playerD', source: 'player' },
  { row: 4, t: T(40), x: 10, y: 64, z: 25, cls: 2, block: 'minecraft:dirt', player: 'playerA', source: 'player' },
];

test('nearRows narrows to the block that was clicked, and the summary names who', () => {
  assert.equal(nearRows(ROWS, 10, 64, 20, 0).length, 2, 'exactly that block: the place and the explosion');
  assert.equal(nearRows(ROWS, 10, 64, 20, 1).length, 3, 'one block over is the furnace');
  assert.equal(nearRows(ROWS, 10, 64, 20, 4).length, 3, 'the dirt at z 25 is five blocks off');
  const s = summarizeRows(nearRows(ROWS, 10, 64, 20, 1));
  assert.equal(s.n, 3);
  assert.deepEqual(s.byPlayer, { playerA: 1, explosion: 1, 'playerD': 1 },
    'a row with no player is named by its source, not filed under nothing');
  assert.deepEqual(s.byKind, { place: 1, break: 1, change: 1 });
  assert.deepEqual(s.byBlock, { 'minecraft:chest': 2, 'minecraft:furnace': 1 });
  assert.ok(s.t0 < s.t1);
});

test('the evidence line says when, who, what kind, which block, where, and how long ago', () => {
  const line = rowLine(ROWS[0], T(10) + 86400_000 * 3);
  assert.match(line, /^2024-05-31 16:58:20  playerA  place  minecraft:chest  at 10,64,20  3 d ago$/);
  const src = rowLine(ROWS[1], T(20) + 3600_000);
  assert.match(src, /explosion  break  minecraft:chest/);
  // The names of the actions are the log's own labels, so a hand check against SQLite agrees.
  assert.ok(ACTION_BLOCK_TOUCH.has(3));
});

test('a card of near-rows names the distance from the block asked about, not 14 copies of the same numbers', () => {
  const at = [11, 64, 18];
  const near = rowLine(ROWS[0], T(10) + 86400_000 * 3, at);
  assert.match(near, /  Δ-1,0,2  3 d ago$/, 'the delta is measured from the block that was clicked');
  assert.ok(!/ at 10,64,20 /.test(near), 'no absolute coordinates when the card is already about them');
  assert.equal(rowLine(ROWS[0], T(10) + 86400_000 * 3, [10, 64, 20]).includes('Δ0,0,0'), true,
    'the asked-about block itself reads as zero away');
});

test('time ago reads in the unit the event deserves', () => {
  const now = 1_760_000_000_000;
  assert.equal(timeAgo(now - 30_000, now), '30 s ago');
  assert.equal(timeAgo(now - 600_000, now), '10 min ago');
  assert.equal(timeAgo(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(timeAgo(now - 5 * 86400_000, now), '5 d ago');
  assert.equal(timeAgo(now - 400 * 86400_000, now), '13.1 mo ago');
  assert.equal(timeAgo(now - 800 * 86400_000, now), '2.2 yr ago');
  assert.equal(formatTime(now), '2025-10-09 08:53:20', 'the database prints wall clock in UTC');
});

// --------------------------------------------------------------------------- real data

test('the baked overworld pack answers the two questions the UI asks', (t) => {
  const file = 'build/ledger/region.ledpack';
  if (!existsSync(file)) return t.skip('not baked yet');
  const P = readPack(readFileSync(file));
  assert.equal(P.dimKey, 'region');
  const all = collectCells(P);
  assert.equal(all.cells.length, 20322, 'every touched chunk is drawable');
  assert.equal(all.max, 4254, 'and the ramp tops out at the busiest chunk');
  assert.equal(all.noHeight, 0, 'the bake copied ground in for all of them');

  const hot = rankCells(all.cells, 1)[0];
  assert.deepEqual([hot.cx, hot.cz], [-3, -8], 'the busiest chunk is the one the tests already know');

  // A "find the bases" tour has to be able to answer for one player alone. 3,884 is that chunk's
  // player-attributed total (build/dbg-ledger.mjs), which is the same number the pill will show.
  const byPlayer = collectCells(P, { player: 4 });
  assert.ok(byPlayer.cells.length > 0 && byPlayer.max > 0, 'a real player id finds cells');
  const broken = collectCells(P, { cls: 3 });
  assert.ok(broken.cells.length > 1000 && broken.max > 0, 'breaks alone still fill the map');
  assert.ok(collectCells(P, { minN: 100 }).cells.length < all.cells.length,
    'the "hide the specks" floor actually hides something');
});
