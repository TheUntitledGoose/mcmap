// ChunkStore behaviour under a stubbed fetch: streaming convergence, holes, eviction and
// cross-chunk neighbour lookups. Synthetic payloads, so this runs without the 3.6 GB world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packChunk } from '../server/chunk-payload.mjs';
import { packBatch } from '../server/world-service.mjs';
import { ChunkStore } from '../web/js/store.js';
import { makeReader, packCells } from '../shared/regionbits.mjs';

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/** section list with one uniform section and one written-out section */
function fakeChunk(cx, cz, { solid = 1, airish = 2, singleTop = true } = {}) {
  const vox = new Uint16Array(4096);
  // voxel entries are palette SLOTS, not global state ids
  for (let i = 0; i < 4096; i++) vox[i] = i % 3 === 0 ? 1 : 0;
  const sections = [{ y: 0, single: singleTop ? 1 : 0, vox: singleTop ? null : vox }];
  return {
    cx, cz, yMin: -1, yCount: 2,
    palette: [solid, airish],
    sections,
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, classicSections: false,
  };
}

/** A synthetic world: present rectangles, with a hole at (2,2)..(3,3) and everything past |4|. */
function present(cx, cz) {
  if (cx < -4 || cx > 4 || cz < -4 || cz > 4) return false;
  if (cx >= 2 && cx <= 3 && cz >= 2 && cz <= 3) return false;
  return true;
}

function stubFetch({ delay = 0 } = {}) {
  const calls = [];
  globalThis.fetch = (url) => {
    const u = new URL(url, 'http://x');
    const q = u.searchParams;
    const cx0 = +q.get('cx0'), cz0 = +q.get('cz0'), w = +q.get('w'), h = +q.get('h');
    calls.push({ cx0, cz0, w, h });
    const frames = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const cx = cx0 + i, cz = cz0 + j;
        // one coordinate deliberately carries a written-out section so the vox path is exercised
        const opts = cx === 1 && cz === 0 ? { singleTop: false } : {};
        frames.push(present(cx, cz) ? packChunk(fakeChunk(cx, cz, opts)) : Buffer.alloc(0));
      }
    }
    const body = toAB(packBatch(frames));
    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, arrayBuffer: async () => body }), delay));
  };
  return calls;
}

async function drain(store, maxMs = 3000) {
  const t0 = Date.now();
  while (store.inflight || store.queue.length) {
    if (Date.now() - t0 > maxMs) throw new Error('store did not drain');
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('store fills a radius, then stops asking', async () => {
  const calls = stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 3 });
  store.request(0, 0, 2);
  await drain(store);
  const want = [...Array(5)].flatMap((_, i) => [...Array(5)].map((_, j) => [i - 2, j - 2]))
    .filter(([cx, cz]) => present(cx, cz)).length;      // one corner of the square is a hole
  assert.equal(store.loaded, want, 'radius 2 => the present part of 5x5');
  assert.equal(want, 24);
  const fetched = calls.length;
  // an idle renderer calls request() every frame; it must not re-download what it already holds
  store.request(0, 0, 2);
  store.request(0, 0, 2);
  await drain(store);
  assert.equal(calls.length, fetched, 'no re-fetch once satisfied');
});

test('store records holes instead of hammering them', async () => {
  const calls = stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 2 });
  store.request(2, 2, 2);                       // centred on the hole
  await drain(store);
  assert.ok(store.missing.has('2,2') && store.missing.has('3,3'), 'hole recorded');
  assert.ok(!store.chunks.has('2,2'), 'hole is not a chunk');
  const fetched = calls.length;
  store.request(2, 2, 2);
  await drain(store);
  assert.equal(calls.length, fetched, 'empty tiles are not re-requested');
  // ...but a tile that is only partly missing is still worth fetching
  store.chunks.delete('0,0');
  store.request(0, 0, 0);
  await drain(store);
  assert.ok(calls.length > fetched, 'partially missing tile is fetched');
  assert.ok(store.chunks.has('0,0'));
});

test('neighbour state lookup crosses chunk borders and negative coordinates', async () => {
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 6 });
  store.request(-3, -3, 2);
  await drain(store);
  const stateOf = (id) => (id === 0 ? -1 : id - 1);
  // inside the chunk
  assert.equal(store.stateIndexAt(-3, -3, 0, 0, 0, stateOf), 0);
  // west neighbour: lx = -1 must land in chunk cx-1 at local x = 15
  assert.equal(store.stateIndexAt(-3, -3, -1, 0, 0, stateOf), store.stateIndexAt(-4, -3, 15, 0, 0, stateOf));
  // south neighbour: lz = 16 -> chunk cz+1, local z = 0
  assert.equal(store.stateIndexAt(-3, -3, 5, 0, 16, stateOf), store.stateIndexAt(-3, -2, 5, 0, 0, stateOf));
  // a neighbour whose section is written out rather than uniform: (1,0) uses a vox array, and its
  // local (0,0) voxel is the airish palette entry, i.e. atlas index 1
  store.request(0, 0, 1);
  await drain(store);
  assert.equal(store.stateIndexAt(0, 0, 16, 0, 0, stateOf), 1);
  // a section the chunk does not carry
  assert.equal(store.stateIndexAt(-3, -3, 0, 999, 0, stateOf), -1);
  // unloaded coordinates read as unknown, which is what makes culling conservative
  assert.equal(store.stateIndexAt(99, 99, 0, 0, 0, stateOf), -1);
});

test('dirty set covers a chunk and its neighbours, and eviction marks the seam', async () => {
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 4, maxChunks: 9 });
  store.request(0, 0, 1);
  await drain(store);
  const dirty = new Set(store.takeDirty(1000));
  assert.ok(dirty.has('0,0') && dirty.has('1,0') && dirty.has('0,-1'), 'neighbours marked');
  assert.ok(store.loaded <= 9, 'evicted to the cap');
  // walking away must drop distant chunks and flag the seam for remeshing
  store.request(4, 4, 1);
  await drain(store);
  const dirty2 = new Set(store.takeDirty(1000));
  assert.ok(dirty2.size > 0, 'eviction flags something for remesh');
  for (const k of store.chunks.keys()) {
    const [cx, cz] = k.split(',').map(Number);
    assert.ok(Math.abs(cx - 4) <= 4 && Math.abs(cz - 4) <= 4, `kept a distant chunk ${k}`);
  }
});

test('dirty marks say who made them', async () => {
  // A dirty mark is a mesh job of tens of milliseconds, so "why is this chunk being meshed again" has
  // to be answerable: arrivals, evictions, a cost-adaptive ring and settings changes all mark, and
  // only the first two are the store's doing.
  stubFetch();
  const marks = [];
  const store = new ChunkStore('minecraft:overworld', {
    tile: 4, maxChunks: 9, onDirty: (k, w) => marks.push(w),
  });
  store.request(0, 0, 1);
  await drain(store);
  assert.ok(marks.includes('arrive'), 'a chunk and its neighbours are marked as arrivals');
  store.takeDirty(1000);
  marks.length = 0;
  store.request(4, 4, 1);
  await drain(store);
  assert.ok(marks.includes('evict'), 'walking away flags the seam as an eviction, not an arrival');
});

test('a dirty pick takes the near keys first, in one pass', async () => {
  // The page drains the dirty set every frame while a camera moves, and which keys come out first
  // matters: a far key taken before a near one meshes scenery nobody is looking at. The pick used to
  // keep a small sorted array and re-sort it per candidate, and the page asked for exactly one key at a
  // time, so a frame that processed 50 keys re-scanned a 1.4k-key set 50 times. Now: one pass, one sort.
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 4, maxChunks: 64 });
  store.request(0, 0, 0);
  await drain(store);                       // request() is what gives the pick a centre
  store.takeDirty(1000);
  // dirty is the queue itself: markDirty() is not public, and the page only ever reaches it through
  // arrivals and evictions. Marking it directly here is how the pick gets a fixed, known set to sort.
  for (const k of ['7,0', '-7,0', '0,6', '0,-6', '1,0', '0,1']) store.dirty.add(k);
  const first = store.takeDirty(2);
  assert.equal(first.length, 2, 'the limit is honoured');
  assert.ok(first.includes('1,0') && first.includes('0,1'), `the two nearest come out first, got ${first}`);
  const rest = store.takeDirty(Infinity);
  assert.equal(rest.length, 4, 'everything else is still queued');
  assert.ok(rest.includes('7,0') && rest.includes('-7,0') && rest.includes('0,6') && rest.includes('0,-6'));
  assert.equal(store.dirty.size, 0, 'a pick removes exactly what it returns');
});

test('dirty set never holds a key for a chunk nobody has', async () => {
  // A stale key here is not just bookkeeping noise: the mesh loop takes one key per frame and stops
  // on the first refusal, so a set full of ghosts starves the chunks that do need meshing.
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 4, maxChunks: 64 });
  store.request(0, 0, 1);
  await drain(store);
  for (const k of store.dirty) {
    const [cx, cz] = k.split(',').map(Number);
    assert.ok(store.has(cx, cz), `dirty holds ${k}, which is not in the store`);
  }
});

test('single-block chunks mesh with unknown neighbours without throwing', async () => {
  // regression guard for the payload reader path the mesher depends on
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 2 });
  store.request(0, 0, 0);
  await drain(store);
  const c = store.get(0, 0);
  assert.equal(c.palette[0], 1);
  assert.equal(c.stateAt(3, 0, 3), 1);
  assert.equal(c.stateAt(3, 999, 3), 0, 'outside any section');
  assert.equal(c.yMin, -1, 'yMin is a section coordinate');
  assert.ok(c.sectionAt(0) && !c.sectionAt(16));
});

test('payloads stay warm beyond the mesh ring, so demoting costs no re-fetch', async () => {
  const calls = stubFetch();
  // maxChunks is only a ceiling on how many chunks exist in memory; evictLimit is the radius that
  // actually gets dropped. They used to be the same derived number, which made "drop the geometry,
  // keep the voxels" impossible: keeping payloads wider than the mesh ring pushed the eviction limit
  // out with it, and shrinking the ring therefore threw the data away too.
  const store = new ChunkStore('minecraft:overworld', { tile: 3, maxChunks: 9, evictLimit: 4 });
  store.request(0, 0, 2);
  await drain(store);
  assert.equal(store.loaded, 24, 'the evict limit keeps everything in a radius-2 square');
  assert.ok(store.bytesHeld > 0, 'payload bytes are counted for the HUD');
  const before = store.bytesHeld;
  store.request(4, 4, 0);                       // the view moves; the old corner is now out of range
  await drain(store);
  assert.ok(store.loaded < 24, 'chunks beyond evictLimit are dropped');
  for (const c of store.chunks.values()) {
    assert.ok(Math.abs(c.cx - 4) <= 4 && Math.abs(c.cz - 4) <= 4, `${c.cx},${c.cz} survived evictLimit`);
  }
  assert.ok(store.bytesHeld < before && store.bytesHeld >= 0, 'byte counter tracks eviction');
  // and eviction must not be a re-fetch source: a chunk dropped then wanted again is fetched once
  const fetched = calls.length;
  store.request(-4, -4, 0);             // definitely outside evictLimit of the (4,4) centre
  await drain(store);
  assert.ok(store.chunks.has('-4,-4'), 'a dropped chunk comes back on demand');
  assert.equal(calls.length, fetched + 1, 'a re-wanted chunk is fetched exactly once');
});

test('dirty chunks are meshed nearest-first, not in arrival order', () => {
  const store = new ChunkStore('minecraft:overworld', {});
  store.center = [0, 0];
  for (const [cx, cz] of [[9, 9], [5, 0], [3, 3], [1, 1], [0, 0]]) store.dirty.add(`${cx},${cz}`);
  // Zooming in promotes a couple of hundred chunks at once and one frame pays for a handful;
  // insertion order filled the far side of the ring before the middle of the view.
  assert.deepEqual(store.takeDirty(2), ['0,0', '1,1'], 'the two nearest go first');
  assert.deepEqual(store.takeDirty(2), ['3,3', '5,0']);
  assert.deepEqual(store.takeDirty(9), ['9,9'], 'an over-large limit just drains the set');
  assert.equal(store.dirty.size, 0, 'taken keys leave the set');
});

test('a held chunk outside the sharp ring is offered exactly once, so the ring needs re-marking', async () => {
  stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 3, maxChunks: 400, evictLimit: 20 });
  store.center = [0, 0];
  store.request(0, 0, 3);
  await drain(store);
  assert.ok(store.loaded >= 40, `a radius-3 square, got ${store.loaded}`);
  assert.ok(store.dirty.has('1,1'), 'an arrival marks itself and its neighbours');
  const offered = store.takeDirty(Infinity);
  assert.equal(offered.length, store.loaded, 'every held chunk is offered once');
  assert.equal(store.dirty.size, 0, 'the store does not remember what the viewer chose to skip');
  // The store has no notion of a mesh ring, so it cannot re-offer a chunk when the view slides over
  // it. That re-marking is the viewer's job (markDetailRing, web/js/main.js): a pan keeps the ring's
  // radius and changes only its centre, and the ring's mark used to run on radius changes alone.
  // Measured with the scan off: 165 of 289 ring chunks held, unmeshed and unqueued after one pan,
  // stable forever, and `dirty 0` claimed the queue was calm (build/q_ringscan.js).
  store.center = [6, 6];
  assert.equal(store.dirty.size, 0, 'a centre change marks nothing by itself');
});

// ---- region coverage: stop asking for ground this save never wrote -----------
// The same rule the server answers /voxels with: a save's bounding box is mostly unwritten, and a
// tile inside a rectangle that was never written still costs a request, a round trip, a queue slot
// and an all-empty frame. Absence here is an optimisation, never truth, so the tests also check the
// two directions where skipping would be a bug: a tile that only touches covered ground, and a
// store with no coverage answer at all.

/** Coverage grid matching `present()`: the four region cells its chunks live in. */
const presentRegions = () => makeReader(packCells(
  [[-1, -1], [-1, 0], [0, -1], [0, 0]].map(([rx, rz]) => ({ rx, rz }))));

test('a tile inside unwritten ground is answered locally, not fetched', async () => {
  const calls = stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 3, coverage: presentRegions() });
  store.request(200, 200, 3);                  // far outside the save's own region cells
  await drain(store);
  assert.equal(calls.length, 0, 'nothing was asked for');
  assert.equal(store.loaded, 0);
  assert.equal(store.covSkipped, 9, 'a 7x7 box at tile 3 is nine tiles');
  assert.equal(store.covSlots, 49, 'and every chunk slot in it is counted exactly once');
  assert.equal(store.missing.size, 0, 'a known-absent region never enters the hole set');
  // an idle renderer keeps asking: still nothing to fetch, and no new traffic
  store.request(200, 200, 3);
  await drain(store);
  assert.equal(calls.length, 0, 'idle over void costs no requests');
});

test('coverage never hides ground: covered and straddling tiles still go out', async () => {
  const calls = stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 6, coverage: presentRegions() });
  store.request(0, 0, 2);                      // wholly inside covered ground
  await drain(store);
  assert.ok(store.loaded > 0, 'covered ground is fetched as before');
  const inside = calls.length;
  // z 25..33: the tile at ty=31 covers chunk rows 31 (region rz=0, covered) and 32-33 (rz=1, not).
  store.request(0, 29, 4);
  await drain(store);
  assert.ok(calls.length > inside, 'a tile that only touches covered ground is still fetched');
  assert.ok(store.missing.has('0,32'), 'and its holes are learned from the empty frames');
});

test('no coverage answer means every tile is ground - the skip is the integration, not the store', async () => {
  const calls = stubFetch();
  const store = new ChunkStore('minecraft:overworld', { tile: 3 });
  store.request(200, 200, 3);
  await drain(store);
  assert.ok(calls.length >= 4, `uninformed store asks anyway: ${calls.length}`);
  assert.ok(store.missing.size > 0, 'and learns the holes the slow way');
});
