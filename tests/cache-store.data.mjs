// The payload cache (server/world-service.mjs). It is the difference between panning being free and
// panning being a re-decode of the save, and it is also the largest thing in build/ - so both halves
// matter: it must survive a round trip through compression, and it must not grow without a bound.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { WorldService, tableTag } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';

const atlasPath = path.join('build', 'assets', 'atlas.json');
const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const ids = buildStateIds(atlas.states.map((s) => s.k));

const opts = {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
  packDir: 'none',
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cache-'));
const clean = () => fs.rmSync(tmpRoot, { recursive: true, force: true });
const svcIn = (dir, extra = {}) => new WorldService('DarkRPG/world', ids, dir, { ...opts, ...extra });
// Where a service keeps a chunk's payload. Asked of the service, never rebuilt by hand here: the tree has
// three levels (save, state table, generation) and a test that retypes them drifts behind the code.
const cfile = (svc, cx, cz, dimId = 'minecraft:overworld') => svc.cachePath(dimId, cx, cz);
const cdir = (svc, dimId = 'minecraft:overworld') => path.dirname(svc.cachePath(dimId, 0, 0));

// A chunk that exists, somewhere in the overworld the user actually looks at.
const HIT = [2, 2];
// A chunk slot inside the present region range that the save left empty.
const MISS = [400, -400];
// A hole inside a region file that *exists*: measured with build/find-hole.mjs, 294 of the 437 overworld
// region files are only partly filled (r.-4.18.mca holds 1 chunk of its 1024 slots), which is exactly
// what the camera sweeps when it pulls far back. This is the case that used to leave a file behind.
const HOLE = [-128, 576];

test('cache round trip: a stored payload opens as the chunk that was decoded', () => {
  const dir = path.join(tmpRoot, 'rt');
  const a = svcIn(dir);
  const raw = a.chunkBytes('minecraft:overworld', HIT[0], HIT[1]);
  assert.ok(raw && raw.length > 1000, 'expected a populated chunk');
  const cpath = cfile(a, HIT[0], HIT[1]);
  const st = fs.statSync(cpath);
  const onDisk = fs.readFileSync(cpath);
  const stored = onDisk.length > 4 && onDisk.subarray(0, 4).equals(Buffer.from('DVZ1'))
    ? zlib.inflateSync(onDisk.subarray(4)) : onDisk;
  assert.ok(onDisk.subarray(0, 4).equals(Buffer.from('DVZ1')), 'cache file should be stored deflated');
  const back = openChunk(stored);
  assert.ok(back, 'stored payload must decode');
  assert.equal(back.cx, HIT[0]);
  assert.equal(back.cz, HIT[1]);
  // 124 KB of voxel truth over the wire as 6-9 KB: the cache has no business being bigger.
  assert.ok(st.size * 4 < raw.length, `cache file ${st.size} vs payload ${raw.length}`);

  // A second service reading the same tree must get byte-identical payloads from the cache, not a
  // re-decode: that is what makes panning back free.
  const b = svcIn(dir);
  const again = b.chunkBytes('minecraft:overworld', HIT[0], HIT[1]);
  assert.equal(b.stats.cacheHits, 1, 'second read should hit the cache');
  assert.equal(b.stats.decodes, 0, 'second read must not re-decode the save');
  assert.deepEqual([...again], [...raw]);
});

test('cache: an empty chunk slot is remembered, not re-probed', () => {
  const dir = path.join(tmpRoot, 'empty');
  const a = svcIn(dir);
  assert.equal(a.chunkBytes('minecraft:overworld', MISS[0], MISS[1]), null);
  const b = svcIn(dir);
  assert.equal(b.chunkBytes('minecraft:overworld', MISS[0], MISS[1]), null);
  assert.equal(b.stats.decodes, 0, 'a recorded hole must not cost another region read');
});

// The 11/07 incident. Pulling far back in the viewer sweeps thousands of unwritten chunk slots a second,
// and each one used to cost a stat of the cache path plus a 0-byte "no such chunk" marker file. That is
// how build/cache reached 665 427 files for 1.42 GB (411 776 of them empty), and the cache bound could
// only be enforced by walking those files - 98 s of blocked event loop, which to anyone looking at the
// map was a server that had died. Absence now comes from the region header, which is already in memory.
test('a hole costs no file: absence is answered from the region header', () => {
  const dir = path.join(tmpRoot, 'holes');
  const svc = svcIn(dir);
  const N = 24;
  let nulls = 0;
  for (let dz = 0; dz < N; dz++) {
    for (let dx = 0; dx < N; dx++) {
      if (svc.chunkBytes('minecraft:overworld', HOLE[0] + dx, HOLE[1] + dz) === null) nulls++;
    }
  }
  assert.ok(nulls >= N * N - 4, `an unwritten corner should be nearly all holes, got ${nulls} of ${N * N}`);
  assert.ok(svc.stats.holes >= N * N - 4, `the holes are counted as holes, saw ${svc.stats.holes}`);
  assert.equal(svc.stats.cacheWrites, 0, 'a hole must not leave a file behind');
  assert.equal(svc.stats.decodes, 0, 'a hole must not decode anything');
  assert.ok(svc.stats.regionOpens <= 2, `one 24x24 box sits in one region, saw ${svc.stats.regionOpens} opens`);
  // And the cache directory must not even have been created for this dimension.
  const dimDir = cdir(svc);
  const left = fs.existsSync(dimDir) ? fs.readdirSync(dimDir) : [];
  assert.equal(left.length, 0, `hole lookups left ${left.length} files behind`);

  // The other half: a region file that is not there at all. The negative answer is remembered, so the
  // second lookup does not stat the path again either.
  const m = svcIn(dir);
  assert.equal(m.chunkBytes('minecraft:overworld', MISS[0], MISS[1]), null);
  const opens = m.stats.regionOpens;
  assert.equal(m.chunkBytes('minecraft:overworld', MISS[0] + 1, MISS[1] + 1), null);
  assert.equal(m.stats.regionOpens, opens, 'a missing region stays a known-missing region');
  assert.equal(m.stats.cacheWrites, 0, 'a missing region must not leave marker files either');
});

test('the cache bound evicts what this server wrote, oldest first, and never walks the tree', () => {
  const dir = path.join(tmpRoot, 'lru');
  const svc = svcIn(dir, { cacheMaxBytes: 40000 });
  const wrote = [];
  for (let i = 0; i < 12; i++) {
    const b = svc.chunkBytes('minecraft:overworld', i, 7);
    if (b) wrote.push(cfile(svc, i, 7));
  }
  assert.ok(wrote.length >= 6, 'need several real payloads to evict');
  assert.ok(svc.stats.cachePruned > 0, 'over budget must evict, not just grow');
  assert.equal(svc.stats.sweeps, 0, 'the request path must not run a reconcile sweep');
  assert.ok(fs.existsSync(wrote[wrote.length - 1]), 'the newest payload stays');
  assert.ok(!fs.existsSync(wrote[0]), 'the oldest payload goes');
  assert.ok(svc.stats.cacheBytes <= 40000, `cache estimate ${svc.stats.cacheBytes} over budget`);
});

test('sweepCacheBudget clears 0-byte markers off the event loop, payloads only when over budget', async () => {
  const dir = path.join(tmpRoot, 'sweep');
  const svc = svcIn(dir, { cacheMaxBytes: 20000 });
  const root = cdir(svc);
  fs.mkdirSync(root, { recursive: true });
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(root, `h_${i}.bin`), Buffer.alloc(0));
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `p_${i}.bin`), Buffer.alloc(2000, 7));

  // Proof it does not run as one blocking pass: a queued continuation has to get a turn while it works.
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const r = await svc.sweepCacheBudget();
  assert.ok(yielded, 'a sweep must hand the event loop back, not run 1 200 stats in one pass');
  assert.equal(r.files, 1220, 'it saw every file');
  const left = fs.readdirSync(root);
  assert.equal(left.filter((f) => f.startsWith('h_')).length, 0, 'empty markers buy nothing: all gone');
  const payloads = left.filter((f) => f.startsWith('p_')).length;
  assert.ok(payloads < 20 && payloads > 0, `expected partial payload eviction, kept ${payloads}`);
  assert.ok(svc.stats.cacheBytes <= 20000, `still over budget: ${svc.stats.cacheBytes}`);
  assert.equal(svc.stats.sweeps, 1);
  // A second call while nothing changed must not stack another sweep up (single-flight guard).
  const [x, y] = await Promise.all([svc.sweepCacheBudget(), svc.sweepCacheBudget()]);
  assert.equal(svc.stats.sweeps, 2, 'the two concurrent calls share one sweep');
});

test('cache size cap evicts old payloads instead of filling the disk', () => {
  const dir = path.join(tmpRoot, 'cap');
  const svc = svcIn(dir, { cacheMaxBytes: 20000 }); // ~20 KB: any real sweep blows straight through it
  for (let i = 0; i < 40; i++) svc.chunkBytes('minecraft:overworld', i, 3);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(cdir(svc));
  assert.ok(svc.stats.cachePruned > 0, 'the cap must actually evict');
  assert.ok(files.length < 22, `expected eviction, found ${files.length} payloads`);
  // Whatever survives must still be a readable payload.
  const live = files.find((p) => fs.statSync(p).size > 100);
  assert.ok(live, 'a populated payload should survive');
});

test('cache tree is namespaced by the state-id table, so two tables cannot mix', () => {
  const a = svcIn(path.join(tmpRoot, 'tag'));
  assert.equal(String(a.tableTag), String(tableTag(ids)));
  // Same size, same ids, one key renamed: the payloads under the old tag now name the wrong block, so
  // the tag has to move. Ids are positional, and hashing only the ids would hash nothing but the count.
  const keys = atlas.states.map((s) => s.k);
  const swapped = buildStateIds(keys.map((k, i) => (i === 100 ? keys[100] + '?x' : k)));
  assert.equal(swapped.size, ids.size);
  assert.notEqual(String(tableTag(swapped)), String(tableTag(ids)), 'a renumbered table must not reuse the tag');
  // Renumbering - same keys, different order - must move the tag for the same reason.
  const renumbered = new Map([...keys].reverse().map((k, i) => [k, i + 1]));
  assert.notEqual(String(tableTag(renumbered)), String(tableTag(ids)));
});

process.on('exit', clean);
