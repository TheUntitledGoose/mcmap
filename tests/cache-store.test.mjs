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

// A chunk that exists, somewhere in the overworld the user actually looks at.
const HIT = [2, 2];
// A chunk slot inside the present region range that the save left empty.
const MISS = [400, -400];

test('cache round trip: a stored payload opens as the chunk that was decoded', () => {
  const dir = path.join(tmpRoot, 'rt');
  const a = svcIn(dir);
  const raw = a.chunkBytes('minecraft:overworld', HIT[0], HIT[1]);
  assert.ok(raw && raw.length > 1000, 'expected a populated chunk');
  const cpath = path.join(dir, String(a.tableTag), a.lightTag, 'region', `${HIT[0]}_${HIT[1]}.bin`);
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
  walk(path.join(dir, String(svc.tableTag), svc.lightTag));
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
