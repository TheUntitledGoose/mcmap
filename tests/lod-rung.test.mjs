// The baked LOD rung chooser. Everything here is the policy the viewer runs per region tile per pass:
// the quality clamp, the "is this column a blob yet" rule, the vertex budget, and the hysteresis that
// stops a slot from swapping rungs every pass. It is a limit-cycle bug that put it here: the budget used
// to be billed starting from the vertices currently on screen, so the fine/coarse cut-off moved as tiles
// streamed, and a handful of tiles flashed between rungs at a still camera (reported at far detail 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLodCell, pickLodRung } from '../shared/lod-format.mjs';

const RUNGS = [16, 8, 4];
const cost = (cell) => ({ 16: 6000, 8: 22000, 4: 84000 })[cell] ?? 0;

test('one rung per slot, and the pass is reproducible', () => {
  // Twelve tiles from near to far, decided nearest-first with a fresh bill.
  const pxs = [1.2, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
  const pass = (held = []) => {
    let spent = 0;
    return pxs.map((px, i) => {
      const r = pickLodRung(RUNGS, px, { minPx: 3, maxPx: 8, maxCell: 16, held: held[i] ?? 0, spent, budget: 9e6, costFor: cost });
      spent = r.spent;
      return r.cell;
    });
  };
  const a = pass(), b = pass();
  assert.deepEqual(b, a, 'the same view asked twice gets the same rungs');
  // Nothing asked for a rung finer than the ladder, and nothing skipped a tile.
  assert.ok(a.every((c) => RUNGS.includes(c)), 'every slot gets a baked rung');
  // The server hands rungs over in whatever order the index listed them; the policy must not care.
  const asc = pxs.map((px) => pickLodRung([4, 8, 16], px, { minPx: 3, maxPx: 8, maxCell: 16, spent: 0, budget: 9e6, costFor: cost }).cell);
  const desc = pxs.map((px) => pickLodRung([16, 8, 4], px, { minPx: 3, maxPx: 8, maxCell: 16, spent: 0, budget: 9e6, costFor: cost }).cell);
  assert.deepEqual(asc, desc, 'rung order in the ladder does not change the answer');
});

test('the vertex budget cuts the ladder where the pass bill crosses it, not before', () => {
  const opts = (spent) => ({ minPx: 3, maxPx: 8, maxCell: 16, spent, budget: 200000, costFor: cost });
  // One near tile that wants the fine rung (84k) and one far tile that would also want it.
  const near = pickLodRung(RUNGS, 1.0, opts(0));
  assert.equal(near.cell, 4, 'a 4-block column at 1 px/block is 4 px: worth the triangles');
  assert.equal(near.spent, 84000, 'and it is billed once');
  const far = pickLodRung(RUNGS, 1.0, opts(near.spent + 120000));
  assert.equal(far.cell, 16, 'past the budget the coarse rung is the answer');
  // The regression: billing from what is already on screen moved this cut-off every pass, because the
  // held total changes as tiles stream in and retire. Same tile, same geometry, different seed.
  const seeded = pickLodRung(RUNGS, 1.0, opts(400000));
  assert.notEqual(seeded.cell, near.cell, 'a seeded bill changes the answer for an unchanged tile');
});

test('a coarse rung is refused on screen size, not on the quality setting alone', () => {
  const q = (px, maxCell) => pickLodRung(RUNGS, px, { minPx: 3, maxPx: 8, maxCell, held: 0, spent: 0, budget: 1e9, costFor: cost }).cell;
  // Far away a 16-block column is a fraction of a pixel: no shape to buy, so keep the coarse rung even
  // when the quality slider would allow cell 4.
  assert.equal(q(0.02, 4), 16, 'sub-pixel columns do not justify a fine rung');
  // Nearer, the same 16-block column is a 20 px blob, so the fine rung is worth going to get.
  assert.equal(q(1.25, 4), 4, 'a 20 px coarse column is a blob: take the fine rung');
  // And the quality clamp is respected in the second case only, which is the direction the slider works.
  assert.ok(q(1.25, 16) <= q(1.25, 4), 'quality never makes the far view coarser where it matters');
});

test('a refused rung never leaves a hole in the world', () => {
  // Only the coarse rung is baked for this ground, and the slider demands finer.
  const r = pickLodRung([16], 3.0, { minPx: 3, maxPx: 8, maxCell: 4, held: 0, spent: 0, budget: 1e9, costFor: cost });
  assert.equal(r.cell, 16, 'painted ground beats an unpainted horizon');
  const none = pickLodRung([], 3.0, { minPx: 3, maxPx: 8, maxCell: 16, spent: 0, budget: 1e9, costFor: cost });
  assert.equal(none.cell, 0, 'nothing baked at all is a request for nothing');
});

test('a held rung survives a pass that would answer differently', () => {
  // Fine tile on hand, columns small but not near a pixel: keep it rather than churn rungs.
  const held = pickLodRung(RUNGS, 0.5, { minPx: 3, maxPx: 8, maxCell: 16, held: 4, spent: 0, budget: 1e9, costFor: cost });
  const fresh = pickLodRung(RUNGS, 0.5, { minPx: 3, maxPx: 8, maxCell: 16, held: 0, spent: 0, budget: 1e9, costFor: cost });
  assert.equal(held.cell, 4, 'the rung on hand is kept while it is not a blob');
  assert.ok(fresh.cell > 4, `without a rung on hand the same tile asks coarser (${fresh.cell})`);
});

test('minPx<=0 asks for one rung everywhere', () => {
  const r = pickLodRung(RUNGS, 5, { minPx: 0, maxPx: 8, maxCell: 16, held: 0, spent: 0, budget: 1e9, costFor: cost });
  assert.equal(r.cell, 16, '?lodcellpx=0 is the single-rung build');
});

test('pickLodCell still upgrades a blob it is holding', () => {
  // 16-block columns at 1.4 px/block are 22 px wide: a tree inside one is a tower.
  assert.equal(pickLodCell(RUNGS, 1.4, 3, 16, 8), 4, 'a coarse blob is replaced by the finest rung that measures up');
  assert.equal(pickLodCell(RUNGS, 0.4, 3, 16, 8), 16, 'and the same rung is left alone at 6 px');
});
