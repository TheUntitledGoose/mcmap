// The store's failure behaviour is the one that can hurt a user: a viewer that re-asks for a tile it
// just failed to get will pin the server's CPU and flood its socket count. So "no tile here" must be
// remembered, and repeated failures must back off rather than spin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LodStore } from '../web/js/lod-store.js';
import { encodeLodTile, LOD_HEADER, LOD_BYTES_PER_VERT, LOD_CELL, pickLodCell } from '../shared/lod-format.mjs';

const POLICY = {
  groundFar: 1, waterOpacity: 0.72, aoFar: 0.949, lightOn: 1,
  darkFloor: 0.32, darkGamma: 0.72, skyScale: 1,
};

const tileBytes = (rx, rz, stamp = 7, verts = 3, policy = POLICY) => {
  const pos = new Float32Array(verts * 3).fill(1);
  const col = new Uint8Array(verts * 4).fill(200);
  const img = encodeLodTile({ rx, rz, stamp, pos, col, count: verts, policy });
  return img;
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

test('tiles fetch, decode and hold; a whole rectangle drains without another request', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    const rx = +new URL('http://x' + url).searchParams.get('rx');
    const rz = +new URL('http://x' + url).searchParams.get('rz');
    return { ok: true, status: 200, arrayBuffer: async () => tileBytes(rx, rz).buffer };
  };
  const st = new LodStore('minecraft:overworld', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0], [0, 1], [1, 0], [1, 1]]);
  st.request(0, 0, 2, 2, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 4, 'all four tiles are held');
  assert.equal(st.gaps(), 0, 'no holes in a view that is satisfied');
  assert.equal(calls, 4, 'one request each, and the queue drained itself');
  const t = st.get(1, 1);
  assert.equal(t.verts, 3);
  assert.equal(t.rx, 1);
});

test('a 404 is remembered: the same view does not re-ask, and does not spin', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: false, status: 404, arrayBuffer: async () => null }; };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0], [1, 0]]);
  st.request(0, 0, 4, 4, [0, 0]);
  await settle(30);
  assert.equal(calls, 2, 'only the two indexed regions were asked for, once each');
  assert.equal(st.inflight.size, 0);
  assert.equal(st.queue.length, 0, 'nothing is left queued behind a failure');
  st.request(0, 0, 4, 4, [0, 0]);
  await settle(20);
  assert.equal(calls, 2, 'a remembered miss is not re-asked on the next view');
});

test('a finer rung arriving retires the coarse tile it lands on, and the ladder is per tile', async () => {
  // Two rungs painting the same ground is z-fighting plus a double vertex bill, so a position holds one
  // tile. This is also the test that the *request* is for the rung the caller asked for.
  const seen = [];
  const fetchFn = async (url) => {
    const q = new URL('http://x' + url).searchParams;
    const rx = +q.get('rx'), rz = +q.get('rz'), cell = +q.get('cell');
    seen.push(cell);
    const verts = cell === 4 ? 9 : 3;
    const pos = new Float32Array(verts * 3).fill(1);
    const col = new Uint8Array(verts * 4).fill(200);
    const img = encodeLodTile({ rx, rz, stamp: 7, cell, pos, col, count: verts, policy: POLICY });
    return { ok: true, status: 200, arrayBuffer: async () => img.buffer };
  };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[LOD_CELL, 0, 0], [4, 0, 0]]);
  assert.deepEqual(st.cells, [4, LOD_CELL], 'finest rung first');
  assert.deepEqual(st.cellsAt(0, 0), [4, LOD_CELL], 'and this tile has both');
  st.request(0, 0, 1, 1, [0, 0], (rx, rz, held, avail) => pickLodCell(avail, 40, 3, held));
  await settle();
  assert.equal(st.tiles.size, 1, 'one tile per position, whichever rung it is');
  assert.equal(st.get(0, 0).cell, 4, 'a 250 block tile at 40 px/block is worth the fine rung');
  assert.equal(st.heldCell(0, 0), 4);
  // Pull back to where a 4-block column is a quarter of a pixel: the coarse rung takes over, and the
  // fine tile that was there goes with it.
  st.request(0, 0, 1, 1, [0, 0], (rx, rz, held, avail) => pickLodCell(avail, 1 / 4000, 3, held));
  await settle();
  assert.equal(st.get(0, 0).cell, LOD_CELL, 'the horizon takes the cheap rung');
  assert.equal(st.tiles.size, 1, 'and never both at once');
  assert.deepEqual(seen, [4, LOD_CELL], 'asked for exactly those two rungs');
});

test('a broken endpoint is tried once per window, then parked', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('socket hang up'); };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0]]);
  const MISS_MS = 30000;
  for (let round = 0; round < 12; round++) {
    // Honest expiry: move the recorded miss back past the base window. The store's own backoff,
    // which grows with the failure count, is what has to keep it quiet.
    for (const [k, t] of [...st.missing]) st.missing.set(k, t - MISS_MS - 1);
    st.request(0, 0, 1, 1, [0, 0]);
    await settle(6);
  }
  // Two attempts out of twelve expiry windows: the second failure widens the wait to
  // twenty windows, so a broken endpoint goes quiet on its own.
  assert.ok(calls <= 4, `repeated failure parks the tile instead of looping (${calls} calls)`);
  assert.ok(st.fails.get(`${LOD_CELL},0,0`) >= 2, 'and the store counted them, per rung');
});

test('regions outside the index are never asked for', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    const rx = +new URL('http://x' + url).searchParams.get('rx');
    const rz = +new URL('http://x' + url).searchParams.get('rz');
    return { ok: true, status: 200, arrayBuffer: async () => tileBytes(rx, rz).buffer };
  };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[5, 5]]);
  st.request(-11, -21, 34, 51, [0, 0]);
  await settle(20);
  assert.equal(calls, 1, 'one tile inside a 1 734 slot box');
  assert.equal(st.wanted.size, 1);
});

test('a tile baked for another far paint is refused, and the layer says which field', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    const rx = +new URL('http://x' + url).searchParams.get('rx');
    const rz = +new URL('http://x' + url).searchParams.get('rz');
    return { ok: true, status: 200, arrayBuffer: async () => tileBytes(rx, rz, 7, 3, { ...POLICY, groundFar: 0 }).buffer };
  };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0]]);
  st.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 0, 'refused');
  assert.equal(st.mismatch, 'groundFar');
  assert.equal(st.badTiles, 1);
  assert.equal(calls, 1, 'and it is not asked for again');

  // Move the settings back and the store must retry straight away, not sit on the old refusal.
  st.policy = { ...POLICY };
  st.forgetMissing();
  st.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 0, 'still the same wrong tile on the wire');
  st.policy = { ...POLICY, groundFar: 0 };
  st.forgetMissing();
  st.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 1, 'and it draws once the viewer agrees with the bake');
  assert.equal(st.mismatch, null);
});

test('a shading change keeps the coarse world painted and says what differs', async () => {
  const fetchFn = async (url) => {
    const rx = +new URL('http://x' + url).searchParams.get('rx');
    const rz = +new URL('http://x' + url).searchParams.get('rz');
    return { ok: true, status: 200, arrayBuffer: async () => tileBytes(rx, rz).buffer };
  };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0]]);
  st.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 1);
  st.policy = { ...POLICY, darkFloor: 0.8 };
  assert.equal(st.recheck(), 0, 'a different light curve is not different terrain');
  assert.equal(st.tiles.size, 1, 'so the distance stays painted instead of going blank');
  assert.equal(st.shadeDiff, 'darkFloor', 'and the viewer is told the tiles disagree on shading');
  assert.equal(st.mismatch, null, 'nothing was refused');
  // A tile arriving over the wire has to be treated the same way, or a settings change would survive
  // as a hole until the next dimension switch.
  const st2 = new LodStore('d', { policy: { ...POLICY, skyScale: 0.5 }, fetchFn });
  st2.setIndex([[0, 0]]);
  st2.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st2.tiles.size, 1, 'a differently shaded tile is still held on arrival');
  assert.equal(st2.shadeDiff, 'skyScale');
  assert.equal(st2.badTiles, 0, 'and it is not counted as a refusal');
});

test('a terrain-rule change does drop them, because the ground itself disagrees', async () => {
  const fetchFn = async (url) => {
    const rx = +new URL('http://x' + url).searchParams.get('rx');
    const rz = +new URL('http://x' + url).searchParams.get('rz');
    return { ok: true, status: 200, arrayBuffer: async () => tileBytes(rx, rz).buffer };
  };
  const st = new LodStore('d', { policy: POLICY, fetchFn });
  st.setIndex([[0, 0]]);
  st.request(0, 0, 1, 1, [0, 0]);
  await settle();
  assert.equal(st.tiles.size, 1);
  st.policy = { ...POLICY, groundFar: 0 };
  assert.equal(st.recheck(), 1, 'the drop is reported, so the renderer can un-draw it');
  assert.equal(st.tiles.size, 0);
  assert.equal(st.mismatch, 'groundFar');
});

test('the index says what each tile costs, before it is ever fetched', () => {
  // The rung chooser needs this: pricing a tile from the mean of the tiles already held makes the
  // decision change the ruler it measures with, which is how a tile ends up cycling between rungs.
  // The server reads the number out of each baked file's header, so it describes the tile, not the view.
  const st = new LodStore('minecraft:overworld', { policy: POLICY, fetchFn: async () => ({ ok: false, status: 404 }) });
  st.setIndex([[16, 3, 4, 6100], [4, 3, 4, 152000], [8, 9, 9]]);
  assert.equal(st.costOf(4, 3, 4), 152000, "the tile's own vertex count");
  assert.equal(st.costOf(16, 3, 4), 6100, 'and the same for a coarser rung at the same slot');
  assert.equal(st.costOf(8, 9, 9), 0, 'an index entry without a cost is 0, not a guess');
  assert.equal(st.costOf(4, 99, 99), 0, 'a slot with nothing baked there is 0');
  st.setIndex([[16, 3, 4, 1]]);
  assert.equal(st.costOf(4, 3, 4), 0, 'a new index replaces the old costs');
});
