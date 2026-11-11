// M12b Tier 3: a logged change drawn as the block it was, tinted by what happened.
//
// The failure this guards is the one the flat tiles have: a marker that says "something happened here" is
// not a picture of the block. So these tests ask whether a place marker and a break marker of the same
// block actually come out different, whether one cube marker is really a cube (36 indices, not 6), and
// whether the cumulative per-marker counts that feed `setDrawRange` are the ones a cube needs - because
// the tile layer's `n * 6` arithmetic would cut a cube into confetti.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import {
  ACTION_WASH, buildTimeBlocks, markerAt, markerOfIndex, resetMarkerLift,
} from '../web/js/ledger-blocks.mjs';
import { filterRows } from '../web/js/ledger-time.mjs';
import { fakeLog } from './fake-ledger.mjs';

const T = (s) => 1717174690000 + s * 1000;

function loadAssets() {
  const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
  const g = fs.readFileSync('build/assets/geometry.bin');
  return new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
}

// rows: [x, y, z, actionId, name, oldName, sec] - the same shape the bake writes into a pack.
function fakeTL(assets, rows) {
  const L = fakeLog(rows.map(([x, y, z, aid, name, old, sec]) =>
    [1, x, y, z, aid, 1, T(sec), name, old]));
  const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  if (!tl.count) throw new Error('fake pack wrote no timeline rows');
  return { tl, P };
}

function build(rows, opts = {}) {
  const assets = loadAssets();
  const { tl, P } = fakeTL(assets, rows);
  resetMarkerLift();
  return buildTimeBlocks(tl, P, Array.from({ length: tl.count }, (_, i) => i), assets,
    stateIdsByName(assets.states), opts);
}

/** Mean of one colour channel over the whole marker set. The colour stream is normalized u8, 4 wide. */
const meanCh = (b, ch) => {
  let s = 0, n = 0;
  for (let v = 0; v < b.col.length / 4; v++) { s += b.col[v * 4 + ch]; n++; }
  return n ? s / n : 0;
};

test('a place marker and a break marker of the same block are not the same picture', () => {
  const place = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]]);
  const brk = build([[2, 64, 3, 3, 'minecraft:air', 'minecraft:stone', 10]]);
  assert.equal(place.stats.markers, 1);
  assert.equal(brk.stats.markers, 1);
  assert.equal(place.stats.cubes, 1);
  assert.equal(brk.stats.cubes, 1);

  // Stone is grey in the atlas, so the wash is the only thing that can tell these apart - and a fill
  // colour (the flat tile palette) would be a multiplier that darkens a sprite instead of tinting it.
  const pR = meanCh(place, 0), pG = meanCh(place, 1);
  const bR = meanCh(brk, 0), bG = meanCh(brk, 1);
  assert.ok(pG > pR, `place wash should favour green: R=${pR.toFixed(1)} G=${pG.toFixed(1)}`);
  assert.ok(bR > bG, `break wash should favour red: R=${bR.toFixed(1)} G=${bG.toFixed(1)}`);
  assert.ok(pG > bG && bR > pR, 'the two washes must move in opposite directions');
  assert.ok(pR > 60 && bR > 60, `a wash must not blacken the sprite: R place ${pR} break ${bR}`);
});

test('one cube marker is a cube, not a quad: the draw range is cumulative indices', () => {
  const one = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]]);
  assert.equal(one.markerEnd.length, 1);
  assert.equal(one.markerSec.length, 1);
  assert.equal(one.markerRow.length, 1);
  const end = one.markerEnd[0];
  assert.equal(one.idx.length, end, 'the index stream must end where the last marker ends');
  assert.equal(end % 3, 0, 'a marker must whole triangles');
  assert.ok(end >= 6 * 6, `a lone cube shows six quads = 36 indices, got ${end}`);
  assert.notEqual(end, 1 * 6, 'n * 6 is the plate arithmetic and would cut the cube apart');

  const two = build([
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [9, 64, 9, 2, 'minecraft:dirt', 'minecraft:air', 20],
  ]);
  assert.ok(two.markerEnd[0] < two.markerEnd[1], 'marker ends must climb in time order');
  assert.ok(two.markerSec[0] < two.markerSec[1], 'markers are built in filter time order');
  assert.ok(two.markerEnd[1] - two.markerEnd[0] >= 36, 'the second cube is a whole cube too');
  assert.equal(two.markerRow[0], 0);
  assert.equal(two.markerRow[1], 1);
});

test('a ray index answers which logged row it belongs to', () => {
  const b = build([
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [9, 64, 9, 3, 'minecraft:air', 'minecraft:dirt', 20],
  ]);
  const mid = b.markerEnd[0];                 // first index of the second marker
  assert.equal(markerOfIndex(b.markerEnd, 0), 0);
  assert.equal(markerOfIndex(b.markerEnd, mid - 1), 0);
  assert.equal(markerOfIndex(b.markerEnd, mid), 1);
  assert.equal(markerOfIndex(b.markerEnd, b.idx.length - 1), 1);
  assert.equal(markerOfIndex(b.markerEnd, b.idx.length), -1, 'past the end is past the end');
  // A pack's time base is its own oldest row, so the two secs are 0 and 10 - not 10 and 20.
  assert.deepEqual(Array.from(b.markerSec), [0, 10]);
  assert.equal(markerAt(b.markerSec, -1), 0, 'before the first change, nothing is drawn');
  assert.equal(markerAt(b.markerSec, 5), 1, 'one marker between the two changes');
  assert.equal(markerAt(b.markerSec, 99), 2, 'and both after');
});

test('a change the atlas has no shape for is counted, and an air row is skipped', () => {
  const b = build([
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [3, 64, 3, 6, 'minecraft:bat', '', 20],           // an entity: no block, no sprite
    [4, 64, 4, 2, 'minecraft:air', '', 30],           // a place of air
  ]);
  assert.equal(b.stats.markers, 1);
  assert.equal(b.stats.unknown, 1, 'a name the atlas cannot draw must be a number, not a silence');
  assert.equal(b.stats.air, 1);
  assert.ok(!b.markerSec.some((s) => s === 30), 'the air row must not reach the timeline');
});

test('plates cost a fraction of blocks, and a quad ceiling stops the build instead of lying', () => {
  const rows = [];
  for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) {
    rows.push([x, 64, z, 2, 'minecraft:stone', 'minecraft:air', 10 + x * 12 + z]);
  }
  const cubes = build(rows, { cull: false });
  const plates = build(rows, { plates: true, cull: false });
  assert.equal(cubes.stats.cubes, 144);
  assert.equal(plates.stats.plates, 144);
  assert.ok(plates.stats.quads * 4 < cubes.stats.quads, 'a plate is one face, not six');
  assert.ok(plates.stats.bytes * 4 < cubes.stats.bytes);
  // The same floor with face culling on (the default): 144*6 = 864 faces, and the 264 side-by-side pairs eat
  // 528 of them, so a slab of claims costs its skin. Measured, not assumed.
  const shut = build(rows, { cull: true });
  assert.equal(shut.stats.culled, 528, 'a 12x12 floor shares 264 side faces, twice');
  assert.ok(shut.stats.quads * 2 < cubes.stats.quads, 'and the floor is drawn as a floor, not as 864 panels');

  const capped = build(rows, { maxQuads: 300 });
  assert.equal(capped.stats.stopped, true, 'the ceiling must say it stopped');
  assert.ok(capped.stats.markers < 144, 'and stop rather than promise the whole filter');
  assert.ok(capped.stats.markers > 0, 'the markers it does have are the OLDEST ones');
  assert.ok(capped.markerSec[capped.markerSec.length - 1]
    < cubes.markerSec[cubes.markerSec.length - 1], 'cutting the tail is what stopping means');
});

test('the wash table covers every action class the timeline can hold', () => {
  assert.equal(ACTION_WASH.length, 7);
  for (const w of ACTION_WASH) {
    assert.equal(w.length, 3);
    for (const c of w) assert.ok(c >= 0 && c <= 1.2, 'a wash is a multiplier on the sprite');
  }
});

test('the panel sentence about what fits is a measured number, not a guess', () => {
  // The real overworld pack, the real atlas. "The place filter is block-shaped near you" and
  // "the ceiling is what stops the any-change filter" are both claims, so both are measured here.
  const assets = loadAssets();
  const fs2 = fs.readFileSync('build/ledger/region.ledpack');
  const P = readPack(fs2.buffer.slice(fs2.byteOffset, fs2.byteOffset + fs2.byteLength));
  const tl = decodeTimeline(fs2.subarray(P.tlBytes[0], P.tlBytes[1]));
  const byName = stateIdsByName(assets.states);

  const place = [];
  for (let i = 0; i < tl.count; i++) if (tl.action[i] === 1) place.push(i);
  resetMarkerLift();
  const b = buildTimeBlocks(tl, P, place, assets, byName, { grow: 1.18, stackGrow: 0.36 });
  assert.equal(b.stats.rows, place.length);
  assert.equal(b.stats.stopped, false, 'the place filter fits, which is why it is the default filter');
  assert.ok(b.stats.markers > 80000, `tens of thousands of block markers, got ${b.stats.markers}`);
  // 63.4 MB of geometry as six faces per claim; 35.8 MB once the faces that sit inside the players' own
  // build are dropped (241,091 of 553,726, and 1,864 claims end up entirely inside). Both numbers are the
  // reason a ceiling exists at all, and the smaller one is why blocks fit where plates used to be forced.
  assert.ok(b.stats.bytes > 30 * 1024 * 1024, 'block markers are a real allocation, not free');
  assert.ok(b.stats.bytes < 45 * 1024 * 1024, 'and culling the interior of a build is most of the saving');
  assert.ok(b.stats.culled > b.stats.faces / 2, `${b.stats.culled} faces sit inside another claim of this filter`);
  assert.equal(b.stats.culled + b.stats.faces, 553726, 'culled plus drawn is what six faces per claim would be');
  assert.ok(b.stats.unknown > 0 && b.stats.unknown < b.stats.markers / 50,
    `a few names the atlas cannot draw: ${b.stats.unknown} of ${b.stats.markers}`);

  const anyChange = Array.from({ length: tl.count }, (_, i) => i);
  resetMarkerLift();
  const all = buildTimeBlocks(tl, P, anyChange, assets, byName, { maxQuads: 100000 });
  assert.equal(all.stats.stopped, true, 'a whole dimension of changes does not fit a near-you budget');
  assert.ok(all.stats.markers < anyChange.length);
});

test('the wash covers every action class the timeline can carry', () => {
  assert.equal(ACTION_WASH.length, 7);                  // six classes plus the outside-the-six bucket
  for (const w of ACTION_WASH) {
    assert.equal(w.length, 3);
    assert.ok(w.every((c) => c > 0 && c <= 1), 'a wash is a multiplier, never a fill');
  }
  assert.ok(ACTION_WASH[1][1] > ACTION_WASH[1][0], 'a place wash lifts green over red');
  assert.ok(ACTION_WASH[2][0] > ACTION_WASH[2][1], 'a break wash lifts red over green');
});

test('marker draw ends climb, and the hit maps back to the marker that drew it', () => {
  const b = build([
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [4, 64, 3, 2, 'minecraft:seagrass', 'minecraft:air', 20],
    [6, 64, 3, 3, 'minecraft:air', 'minecraft:stone', 30],
  ]);
  for (let i = 1; i < b.markerEnd.length; i++) assert.ok(b.markerEnd[i] > b.markerEnd[i - 1]);
  assert.equal(b.markerEnd[b.markerEnd.length - 1], b.idx.length);
  // A click raycasts triangles: one triangle per face, three indices each, two triangles per quad. Asking
  // with the raw triangle number times six looks at twice the offset; the page hit this by answering a
  // marker further along the buffer than the pixel it was aimed at.
  for (const item of [0, 1, 2]) {
    const start = item ? b.markerEnd[item - 1] : 0;
    for (const off of [0, 3, 6, b.markerEnd[item] - start - 3]) {
      assert.ok(Number.isInteger((start + off) / 3), 'a marker starts and ends on a triangle');
      const q = (start + off) / 3;                       // what three's faceIndex reports
      assert.equal(markerOfIndex(b.markerEnd, Math.floor(q / 2) * 6), item, `item ${item} offset ${off}`);
    }
    assert.ok(markerOfIndex(b.markerEnd, b.markerEnd[item]) !== item, 'the next marker starts at its end');
  }
});

test('a plant marker is the plant, not a cube - and its index count is what the draw range uses', () => {
  const b = build([[9, 64, 9, 2, 'minecraft:grass', 'minecraft:air', 10]]);
  assert.equal(b.stats.models, 1, 'grass is a model state in this atlas');
  assert.equal(b.stats.cubes, 0);
  // grass bakes to 4 quads, so the marker spans 24 indices, not a cube's 36. A draw range computed as
  // "items x 6" or "items x 36" would either cut the plant in half or eat the next marker.
  assert.equal(b.markerEnd[0], 24);
  assert.equal(b.idx.length, 24);
  const cube = build([[9, 64, 9, 2, 'minecraft:stone', 'minecraft:air', 10]]);
  assert.equal(cube.markerEnd[0], 36);
});

test('the real overworld place filter fits under the default ceiling, as blocks', () => {
  const realBuf = fs.readFileSync('build/ledger/region.ledpack');
  const real = readPack(realBuf.buffer.slice(realBuf.byteOffset, realBuf.byteOffset + realBuf.byteLength));
  const tl = decodeTimeline(realBuf.subarray(real.tlBytes[0], real.tlBytes[1]));
  assert.ok(tl.count > 300000, 'the shipped overworld timeline');
  const got = filterRows(tl, { who: 0, cls: 2 });        // cls 2 = block place
  assert.ok(got.n > 80000, `the place filter, got ${got.n}`);
  const b = buildTimeBlocks(tl, real, got.order, loadAssets(), stateIdsByName(loadAssets().states),
    { maxBytes: Infinity });
  assert.ok(b.stats.bytes > 20 * 1024 * 1024, 'a block per change is a real cost, and the panel says so');
  assert.ok(b.stats.bytes < 128 * 1024 * 1024, 'and the default ceiling has to hold it');
  assert.ok(b.stats.verts < 4_000_000);
  assert.ok(b.stats.markers > 80000);
});

// Why this exists: a viewer saw green squares over ground and no blocks, and asked if only the first N
// ledger rows are replayed. Half the answer is reach (the voxel replay only runs where a full-resolution
// chunk mesh paints the ground), and the half these lines can pin is that the marker itself was flush with
// the block it describes - six faces coplanar with the real block's own, which reads as a painted tile.
test('a marker is bigger than its block by the grow factor, and grow=1 is flush again', () => {
  const boxOf = (b) => {
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < b.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], b.pos[i + k]); hi[k] = Math.max(hi[k], b.pos[i + k]);
      }
    }
    return { lo, hi };
  };
  const flush = boxOf(build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]], { grow: 1 }));
  assert.deepEqual(flush.lo, [2, 64, 3], 'one unit of grow is the block itself, in world blocks');
  assert.deepEqual(flush.hi, [3, 65, 4]);

  const grown = boxOf(build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]], { grow: 1.18 }));
  const out = 0.09;
  assert.ok(flush.lo[0] - grown.lo[0] > out - 1e-4 && grown.hi[0] - flush.hi[0] > out - 1e-4,
    `a 0.09 grow must stand outside the block on both sides, got ${flush.lo[0] - grown.lo[0]} / ${grown.hi[0] - flush.hi[0]}`);
  assert.ok(grown.lo[1] < flush.lo[1] && grown.hi[1] > flush.hi[1], 'grow must be about the block centre in y too');
});

// Why this exists: a block placed and later broken drew two markers the same size, so they fought for the
// same pixels. A raycast measured who won - the OLDER placement - which means a click answered a block that
// had already left, and a person saw green and red occupying one block. The newest claim must own the block.
test('a later claim at one voxel encloses the claim it supersedes, instead of overlapping it', () => {
  const boxOf = (b, item) => {
    const from = item ? b.markerEnd[item - 1] : 0;
    const to = b.markerEnd[item];
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let k = from; k < to; k++) {
      const v = b.idx[k] * 3;
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], b.pos[v + c]); hi[c] = Math.max(hi[c], b.pos[v + c]); }
    }
    return { lo, hi };
  };
  const rows = [
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],     // place
    [2, 64, 3, 3, 'minecraft:air', 'minecraft:stone', 30],     // break, same voxel, later
  ];
  const stacked = build(rows, { grow: 1.18, stackGrow: 0.36 });
  assert.equal(stacked.stats.markers, 2, 'both claims are drawn');
  assert.equal(stacked.stats.stacked, 1, 'one of them knows a claim came before it here');
  assert.equal(stacked.stats.maxStack, 2, 'two claims share this voxel');

  const a = boxOf(stacked, 0), b = boxOf(stacked, 1);
  for (const c of [0, 2]) {
    assert.ok(b.lo[c] < a.lo[c] - 0.01 && b.hi[c] > a.hi[c] + 0.01,
      `the break must stand outside the place on axis ${c}: place ${a.lo[c]}..${a.hi[c]} break ${b.lo[c]}..${b.hi[c]}`);
  }
  assert.ok(b.lo[1] < a.lo[1] && b.hi[1] > a.hi[1], 'and in height too');

  // The visible shell is the newer claim, so its colour is what a person sees: red, not green.
  const redOuter = (x) => x[0] > x[1];
  const ch = (x, item) => { const from = (item ? x.markerEnd[item - 1] : 0); let r = 0, g = 0, n = 0;
    for (let k = from; k < x.markerEnd[item]; k++) { const v = x.idx[k] * 4; r += x.col[v]; g += x.col[v + 1]; n++; }
    return [r / n, g / n]; };
  assert.ok(redOuter(ch(stacked, 1)), 'the outer marker is the break, and it is washed red');
  assert.ok(!redOuter(ch(stacked, 0)), 'the enclosed marker is the place, washed green');

  // The default is not a ramp at all: one voxel is ONE marker, and it is the claim standing there now.
  const one = build(rows, { grow: 1.18, stackGrow: 0 });
  assert.equal(one.stats.markers, 1, 'a voxel claimed twice draws one marker, not two shells');
  assert.equal(one.stats.deduped, 1, 'and says out loud that it dropped the superseded claim');
  assert.equal(one.markerRow[0], 1, 'the marker is the NEWER claim, the one true at the playhead');
  assert.equal(one.markerRepeat[0], 1, 'and it carries that this voxel was claimed twice');
  assert.ok(redOuter(ch(one, 0)), 'the one marker is the break, washed red');
  assert.equal(boxOf(one, 0).lo[0], boxOf(stacked, 0).lo[0], 'at one size, the same shell every claim shares');

  // Bound: this save has one voxel logged 292 times. A linear ramp would draw a 30 m tower for it.
  const many = [];
  // A break names the block that LEFT, and the timeline reads that out of the old object id, so the block
  // goes in the old slot for break rows and the new slot for place rows.
  for (let i = 0; i < 40; i++) many.push([7, 64, 7, i % 2 ? 2 : 3, i % 2 ? 'minecraft:stone' : 'minecraft:air',
    i % 2 ? 'minecraft:air' : 'minecraft:stone', 100 + i]);
  const deep = build(many, { grow: 1.18, stackGrow: 0.36 });
  assert.equal(deep.stats.markers, 40);
  const first = boxOf(deep, 0), last = boxOf(deep, 39);
  const half = (first.hi[0] - first.lo[0]) / 2 + 2 * 0.36 + 1e-6;
  const mid = (first.lo[0] + first.hi[0]) / 2;
  assert.ok(Math.abs(last.hi[0] - mid) < half && Math.abs(last.lo[0] - mid) < half,
    `a 40-deep stack stays inside the saturated reach: ${(last.hi[0] - mid).toFixed(3)} > ${(half - 0.5).toFixed(3)}`);
  for (let i = 1; i < 40; i++) {
    const p = boxOf(deep, i - 1), q = boxOf(deep, i);
    assert.ok(q.hi[0] >= p.hi[0], `depth ${i}: the ramp must never shrink`);
  }
});

test('a marker stands on the grid: grow=1 is the voxel, and no cube reaches into its neighbour', () => {
  const boxOf = (b, item) => {
    const from = item ? b.markerEnd[item - 1] : 0, to = b.markerEnd[item];
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let k = from; k < to; k++) {
      const v = b.idx[k] * 3;
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], b.pos[v + c]); hi[c] = Math.max(hi[c], b.pos[v + c]); }
    }
    return { lo, hi };
  };
  // Two claims two blocks apart, one of them in negative world x where a packed float key used to blur them.
  const rows = [[-40, 64, -128, 2, 'minecraft:stone', 'minecraft:air', 10],
    [-38, 64, -128, 2, 'minecraft:stone', 'minecraft:air', 11]];
  const a = build(rows, { grow: 1 });
  assert.equal(a.stats.markers, 2, 'two voxels are two markers');
  assert.equal(a.stats.deduped, 0, 'and neither is dropped for being the other');
  const want = [[-40, -39], [-38, -37]];
  for (const item of [0, 1]) {
    const b = boxOf(a, item);
    for (const [c, lo, hi] of [[0, want[item][0], want[item][1]], [1, 64, 65], [2, -128, -127]]) {
      assert.ok(Math.abs(b.lo[c] - lo) < 1e-6 && Math.abs(b.hi[c] - hi) < 1e-6,
        `marker ${item} axis ${c} is exactly ${lo}..${hi}: ${b.lo[c]}..${b.hi[c]}`);
    }
  }
  // The shell that used to be default (1.09) reaches past the voxel edge into the neighbour's space, which
  // is where two coplanar top faces at one height started fighting for the same pixels.
  const shell = build(rows, { grow: 1.18 });
  const s0 = boxOf(shell, 0);
  assert.ok(s0.hi[0] > -39 + 0.01, 'and `?timegrow` still says it does, as an opt-in');
});

test('the builder says which chunk each marker stands in, which is how far the replay reaches', () => {
  const a = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]]);
  assert.deepEqual([a.markerCx[0], a.markerCz[0]], [0, 0], 'a block at 2,3 sits in chunk 0,0');
  const b = build([[2, 64, 3, 3, 'minecraft:air', 'minecraft:stone', 10],
    [18, 64, 3, 2, 'minecraft:oak_planks', 'minecraft:air', 20]]);
  assert.equal(b.stats.markers, 2);
  assert.deepEqual(Array.from(b.markerCx), [0, 1], 'the second row stands in the next chunk over');
  assert.deepEqual(Array.from(b.markerCz), [0, 0]);
});

// A wall of placed blocks is the case the flat tiles never showed: 1,661 cube markers sitting shoulder to
// shoulder. The world's own mesher throws away a face whose neighbour is solid; a marker layer that does not
// draws three in five faces into the inside of the thing the players built, and those back-faces seen through
// the gaps in the near skin are what a person calls "inverted normals, I see the opposite faces".
test('a face with another claim of the same filter behind it is inside the build, so it is not drawn', () => {
  const wall = [[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [3, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 20]];
  const open = build(wall, { cull: false });
  const shut = build(wall, { cull: true });
  assert.equal(open.stats.markers, 2);
  assert.equal(shut.stats.markers, 2, 'the wall is still two blocks of claim');
  assert.equal(open.stats.faces, 12, 'six faces each when nothing is culled');
  assert.equal(shut.stats.faces, 10, 'the two faces that met in the middle are gone');
  assert.equal(shut.stats.culled, 2);
  assert.equal(shut.stats.tris, open.stats.tris - 4, 'and the geometry went with them: two quads, four triangles');
});

test('a claim the build completely hides is skipped, and counted as inside rather than as shapeless', () => {
  const cube = [];
  for (let dx = 0; dx < 3; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dz = 0; dz < 3; dz++) cube.push([4 + dx, 64 + dy, 4 + dz, 2, 'minecraft:stone', 'minecraft:air', 10]);
    }
  }
  const shut = build(cube, { cull: true });
  const open = build(cube, { cull: false });
  assert.equal(open.stats.markers, 27);
  assert.equal(shut.stats.markers, 26, 'the one block with a claim on all six sides draws nothing');
  assert.equal(shut.stats.enclosed, 1);
  assert.equal(shut.stats.noModel, 0, 'a hidden claim is not a missing model');
  // 3x3x3: 27*6 faces, 54 of them shared pairs -> the skin is 6*9 = 54 faces.
  assert.equal(shut.stats.faces, 54);
});

test('a model marker keeps the shape the model authored, whatever the grow factor says', () => {
  // A cube needs grow so it is not coplanar with the block it describes. An authored model does not: its
  // geometry can leave the voxel (a wall torch, a 1x2 monolith), and scaling that distance about the voxel
  // centre multiplies a real shape into a wrong one. So a model marker must come out the same size at any
  // grow, while a cube marker must not.
  const rows = [[2, 64, 3, 2, 'minecraft:oak_stairs', 'minecraft:air', 10]];
  const flush = build(rows, { grow: 1 });
  const blown = build(rows, { grow: 3, stackGrow: 0.4 });
  assert.equal(flush.stats.markers, 1);
  assert.equal(blown.stats.markers, 1);
  assert.ok(flush.stats.models === 1 && blown.stats.models === 1, 'oak_stairs must come from the model path');
  assert.equal(blown.pos.length, flush.pos.length);
  let maxd = 0;
  for (let i = 0; i < flush.pos.length; i++) maxd = Math.max(maxd, Math.abs(blown.pos[i] - flush.pos[i]));
  assert.ok(maxd < 1e-4, `a model marker moved ${maxd.toFixed(3)} blocks under grow=3; it must not move at all`);
  const cubed = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]], { grow: 1 });
  const cubeg = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]], { grow: 1.18 });
  const wide = (b) => Math.max(...Array.from({ length: b.pos.length / 3 }, (_, v) => b.pos[v * 3]))
    - Math.min(...Array.from({ length: b.pos.length / 3 }, (_, v) => b.pos[v * 3]));
  assert.ok(wide(cubeg) > wide(cubed) + 0.15, 'a cube marker still gets the grow that keeps it off the terrain');
});

// The repeat counter that decides how far a marker reaches used to pack x,y,z into one float
// ((x+2^21)*2^34 + (y+2^12)*2^22 + (z+2^21)). That is 56 bits, and a double is exact only below 2^53: out at
// x -40 the spacing is 8, so z -128, -125 and -122 collapse to ONE number. Measured over the shipped
// overworld place filter with build/dbg-markermass.mjs: 43,235 of 90,045 claims were read as repeats of a
// neighbour's voxel, and the deepest stack as 35 instead of 13. Half the markers in the picture were being
// scaled and lifted as if they were the tenth claim on a voxel - a wall of blocks a block wide standing
// half-way between grid lines, which is what a person means by "waaaay off grid".
test('two voxels a few blocks apart are two voxels, not the same claim twice', () => {
  const boxOf = (b, m) => {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let prev = m ? 0 : 0;
    for (let k = (m ? b.markerEnd[m - 1] : 0); k < b.markerEnd[m]; k++) {
      const p = b.idx[k] * 3;
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], b.pos[p + a]); hi[a] = Math.max(hi[a], b.pos[p + a]);
      }
    }
    return { lo, hi };
  };
  const opts = { grow: 1.18, stackGrow: 0.36, cull: false };
  const apart = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [2, 64, 6, 2, 'minecraft:stone', 'minecraft:air', 20],
    [2, 64, 10, 2, 'minecraft:stone', 'minecraft:air', 30]], opts);
  assert.equal(apart.stats.stacked, 0, 'three voxels 3 and 4 apart in z are three separate claims');
  for (let m = 1; m < 3; m++) {
    const a = boxOf(apart, 0), b = boxOf(apart, m);
    const w = (q) => q.hi[0] - q.lo[0];
    assert.ok(Math.abs(w(b) - w(a)) < 1e-6, `marker ${m} is ${w(b).toFixed(3)} wide against ${w(a).toFixed(3)}`);
  }
  const twice = build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10],
    [2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 20]], opts);
  assert.equal(twice.stats.stacked, 1, 'one voxel claimed twice is a real stack');
  const [first, second] = [boxOf(twice, 0), boxOf(twice, 1)];
  assert.ok(second.hi[0] - first.hi[0] > 0.1, 'and the newer claim reaches outside the older one');
});
