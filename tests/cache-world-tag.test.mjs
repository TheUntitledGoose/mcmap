// The save level of the payload cache: cache/<world>/<state table>/<generation>/<dimension>/<chunk>.bin.
//
// It exists because of a bug, not a feature. A payload embeds *state ids*, and those ids come from the
// atlas - so two saves running the same mods share a state table, and both call their biggest dimension
// folder `region`. Keyed on table + generation alone, a payload decoded from save A is a plausible-looking
// answer for save B: the cache opens, the chunk decodes, and the wrong save is on screen.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { worldTagFor, tagHash, isWorldTag } from '../shared/world-tag.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { levelSeed } from '../server/world-dims.mjs';

// ---------------------------------------------------------------- the tag itself

test('the tag is legible, stable, and different when either the path or the seed is', () => {
  // Invented seeds, invented paths: this test is about the function's shape, and a real save's seed is
  // not something a public repo needs to carry.
  const a = worldTagFor({ dir: '/srv/mcmap/worlds/DarkRPG/world', seed: '-1234567890123456789' });
  assert.equal(a, worldTagFor({ dir: '/srv/mcmap/worlds/DarkRPG/world', seed: '-1234567890123456789' }),
    'the same save must keep the same cache across restarts');
  assert.ok(a.startsWith('darkrpg-world'), `the label should say where it came from, got ${a}`);
  assert.notEqual(a, worldTagFor({ dir: '/srv/mcmap/worlds/DarkRPG/world', seed: '111' }),
    'a different seed is a different save');
  assert.notEqual(a, worldTagFor({ dir: '/srv/mcmap/worlds/SkyBlock/world', seed: '-1234567890123456789' }),
    'the same seed twice over (a copied template) is still two saves');
  assert.equal(worldTagFor({ dir: 'D:\\saves\\DarkRPG\\world', seed: '7' }),
    worldTagFor({ dir: 'D:/saves/DarkRPG/world', seed: '7' }),
    'a Windows path and the same path written with forward slashes are one save');
});

test('every tag the function can produce is one legal directory name', () => {
  for (const o of [
    { dir: '', seed: '' },
    { dir: '/srv/mcmap/worlds/darkrpg/save', seed: '1' },
    { dir: 'x', override: 'Dark RPG' },
    { dir: 'x', override: '../../etc/passwd' },
    { dir: 'x', override: '...' },
    { dir: 'x', override: '\u041f\u0440\u0438\u0432\u0435\u0442' },       // Cyrillic: nothing left to name it with
    { dir: 'x', override: 'a'.repeat(200) },
  ]) {
    const t = worldTagFor(o);
    assert.ok(isWorldTag(t), `tag ${JSON.stringify(t)} for ${JSON.stringify(o)} is not a safe name`);
    assert.equal(path.basename(t), t, 'a tag must not contain a separator');
  }
  // A hostile override must not become a path out of the cache directory.
  const t = worldTagFor({ dir: 'x', override: '../../../Windows' });
  assert.ok(!t.includes('/') && !t.includes('\\') && !t.includes('..') && !t.startsWith('.'),
    `an override escaped the cache directory: ${t}`);
});

test('--world-tag names the cache, and the seed still says which save that name stands for', () => {
  const named = worldTagFor({ dir: '/anything/at/all', override: 'darkrpg' });
  assert.ok(named.startsWith('darkrpg.'), `a named tag should still read as the name, got ${named}`);
  assert.equal(worldTagFor({ dir: '/anything/at/all', override: 'darkrpg', seed: '42' }),
    worldTagFor({ dir: '/elsewhere/entirely', override: 'darkrpg', seed: '42' }),
    'the name and seed travel together, so a cache volume can move between boxes');
  assert.notEqual(named, worldTagFor({ dir: '/anything/at/all', override: 'darkrpg', seed: '77' }),
    'the same slug over a different save must not inherit that save\'s payloads - rsync and tar keep mtimes, '
    + 'so the per-chunk staleness check cannot see the swap');
  assert.notEqual(worldTagFor({ dir: '/x', override: 'world one' }), worldTagFor({ dir: '/x', override: 'world-two' }));
  assert.ok(isWorldTag(worldTagFor({ dir: '/x', override: '\u30b9\u30d1\u30a4\u30b7' })));
});

// ---------------------------------------------------------------- two saves, one state table

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worldtag-'));
const fakeSave = (name) => {
  // A save the service can *list* without a real region file inside: enough to build dims, a table tag and
  // a payload path, which is all this test asks about.
  const dir = path.join(tmp, name, 'save');
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), Buffer.alloc(8192, 3));
  return dir;
};
const ids = () => buildStateIds(['minecraft:air', 'minecraft:stone', 'minecraft:oak_log']);
const svcIn = (worldDir, cacheDir, extra = {}) =>
  new WorldService(worldDir, ids(), cacheDir, { packDir: 'none', ...extra });

test('two saves with the same state table never share a payload file', () => {
  const cache = path.join(tmp, 'cache-shared');
  const a = svcIn(fakeSave('darkrpg'), cache);
  const b = svcIn(fakeSave('skyblock'), cache);
  assert.equal(String(a.tableTag), String(b.tableTag),
    'the whole point: same mods, so the state table says they match');
  assert.notEqual(a.worldTag, b.worldTag, 'and the save level is what tells them apart');
  for (const [cx, cz] of [[0, 0], [3, -8], [-512, 511]]) {
    const pa = a.cachePath('minecraft:overworld', cx, cz);
    const pb = b.cachePath('minecraft:overworld', cx, cz);
    assert.notEqual(pa, pb, `${cx},${cz} would be read from the other save: ${pa}`);
    for (const p of [pa, pb]) {
      const rel = path.relative(cache, p);
      assert.ok(rel && !rel.startsWith('..'), `a payload path must stay inside the cache root: ${rel}`);
    }
  }
});

test('the cache tree says save, then state table, then generation, then dimension', () => {
  const cache = path.join(tmp, 'cache-shape');
  const svc = svcIn(fakeSave('darkrpg'), cache);
  const p = svc.cachePath('minecraft:overworld', 3, -8);
  assert.deepEqual(
    path.relative(cache, p).split(/[\\/]+/),
    [svc.worldTag, String(svc.tableTag), svc.lightTag, 'region', '3_-8.bin'],
    'the layout README and HANDOFF promise');
  // Same save, new process: the same directory, so a restart reuses 1.4 GB of decoding.
  assert.equal(svcIn(fakeSave('darkrpg'), cache).worldTag, svc.worldTag);
});

test('playing in the save does not move its cache', () => {
  const world = fakeSave('played');
  const cache = path.join(tmp, 'cache-played');
  const before = svcIn(world, cache).worldTag;
  // Someone places blocks: a region file grows, another appears. The tag must survive that, or the whole
  // cache evaporates on the first block placed and every view pays the decode again.
  fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(120000, 9));
  fs.writeFileSync(path.join(world, 'region', 'r.0.1.mca'), Buffer.alloc(4096, 1));
  assert.equal(svcIn(world, cache).worldTag, before, 'a cache keyed on region contents would be useless');
});

test('levelSeed reads a seed only when level.dat says one, and never throws', () => {
  assert.equal(levelSeed(path.join(tmp, 'no-such-world')), '', 'no level.dat is no seed, not a crash');
  assert.equal(levelSeed(path.join(tmp, 'darkrpg', 'save')), '', 'a save without level.dat still gets a tag');
  assert.ok(isWorldTag(worldTagFor({ dir: path.join(tmp, 'darkrpg', 'save'), seed: levelSeed(tmp) })));
});

// ---------------------------------------------------------------- retag tool

const node = process.execPath;
const tool = path.join('tools', 'cache-retag.mjs');
const runTool = (args) => spawnSync(node, [tool, ...args], { encoding: 'utf8' });

test('cache-retag moves an old cache under the save level, and refuses to merge two trees', () => {
  const world = fakeSave('retaggable');
  const cache = path.join(tmp, 'cache-old');
  const old = path.join(cache, 'table1', 'lit', 'region', '12_-4.bin');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, Buffer.from('DVZ1pretend-payload'));
  const bytes = fs.readFileSync(old);

  const dry = runTool(['--dir', cache, '--world', world, '--dry']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(fs.existsSync(old), 'a dry run must not touch a single file');
  const tag = (dry.stdout.match(/tag (\S+)/) || [])[1];
  assert.ok(tag && isWorldTag(tag), `the dry run should print the tag it would use, got ${dry.stdout}`);

  const run = runTool(['--dir', cache, '--world', world]);
  assert.equal(run.status, 0, run.stderr);
  const moved = path.join(cache, tag, 'table1', 'lit', 'region', '12_-4.bin');
  assert.ok(fs.existsSync(moved), 'the payload moves one level deeper, byte for byte');
  assert.deepEqual(fs.readFileSync(moved), bytes, 'retagging is a rename, not a rewrite');
  assert.ok(!fs.existsSync(path.join(cache, 'table1')), 'the old root-level table directory is gone');

  // Idempotent: running it again has nothing left to move, and says so without deleting anything.
  const again = runTool(['--dir', cache, '--world', world]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(/moved 0 state-table/.test(again.stdout), `second run should find nothing, got ${again.stdout}`);
  assert.ok(fs.existsSync(moved), 'and must leave the cache where it put it');

  // A destination that already exists is a merge of two saves' payloads: refuse loudly.
  const srcTable = path.join(cache, 'table2', 'lit', 'region');
  const dstTable = path.join(cache, tag, 'table2', 'lit', 'region');
  fs.mkdirSync(srcTable, { recursive: true });
  fs.mkdirSync(dstTable, { recursive: true });
  const at = (p, bytes, minAgo) => {
    fs.writeFileSync(p, Buffer.from(bytes));
    const t = new Date(Date.now() - minAgo * 60e3);
    fs.utimesSync(p, t, t);
  };
  at(path.join(srcTable, '0_0.bin'), 'the-old-tree-copy', 60);      // dest copy is fresher
  at(path.join(dstTable, '0_0.bin'), 'the-live-tree-copy', 5);
  at(path.join(srcTable, '0_1.bin'), 'the-old-tree-copy', 5);
  at(path.join(dstTable, '0_1.bin'), 'the-live-tree-copy', 60);     // source copy is fresher
  at(path.join(srcTable, '9_9.bin'), 'only-in-the-old-tree', 60);
  const clash = runTool(['--dir', cache, '--world', world]);
  assert.equal(clash.status, 2, `a colliding destination must not be merged: ${clash.stdout}${clash.stderr}`);
  assert.ok(fs.existsSync(path.join(srcTable, '0_0.bin')),
    'refusing means the payload is still where it was');
  assert.match(clash.stderr, /--merge/);

  // --merge: the same save and the same state table on both sides, so a chunk file that exists twice is
  // settled by mtime - the newer payload is the one closer to the region file it was decoded from.
  const merged = runTool(['--dir', cache, '--world', world, '--merge']);
  assert.equal(merged.status, 0, `${merged.stdout}${merged.stderr}`);
  assert.ok(!fs.existsSync(path.join(cache, 'table2')), 'the old root-level tree is gone either way');
  assert.equal(fs.readFileSync(path.join(dstTable, '0_0.bin')).toString(), 'the-live-tree-copy',
    'the newer payload wins a clash');
  assert.equal(fs.readFileSync(path.join(dstTable, '0_1.bin')).toString(), 'the-old-tree-copy',
    'and it wins whichever side it was sitting on');
  assert.equal(fs.readFileSync(path.join(dstTable, '9_9.bin')).toString(), 'only-in-the-old-tree',
    'a payload with no counterpart just moves');
  assert.match(merged.stdout, /2 on both sides/);
});

test('the retag tool can just say what a save would be called, which is what ops needs', () => {
  const r = runTool(['--print-tag', '--world', path.join(tmp, 'darkrpg', 'save')]);
  assert.equal(r.status, 0, r.stderr);
  const tag = r.stdout.trim().split('\n')[0];
  assert.ok(isWorldTag(tag), r.stdout);
  assert.equal(tag, worldTagFor({ dir: path.resolve(path.join(tmp, 'darkrpg', 'save')), seed: '' }));
});

test('cache-retag moves a whole cache when only the NAME of the save moved', () => {
  const world = fakeSave('renamed-save');
  const cache = path.join(tmp, 'cache-renamed');
  const OLD = 'oldname.11111111', NEW = 'newname.22222222';
  const putAt = (tag, dim, name, body, ageMin) => {
    const p = path.join(cache, tag, 'table1', 'lit', dim, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(body));
    const t = new Date(Date.now() - ageMin * 60e3);
    fs.utimesSync(p, t, t);
    return p;
  };
  const both = putAt(OLD, 'region', '5_6.bin', 'DVZ1old-a', 120);
  const newer = putAt(NEW, 'region', '5_6.bin', 'DVZ1newer-a', 5);   // same chunk, decoded later
  const theirs = putAt(NEW, 'region', '9_9.bin', 'DVZ1theirs', 5);

  // Refused first: two trees for one state table is the merge the tool will not do unasked.
  const noMerge = runTool(['--dir', cache, '--world', world, '--from', OLD, '--to', NEW]);
  assert.equal(noMerge.status, 2, 'a table that exists on both sides is refused without --merge');
  assert.match(noMerge.stderr, /REFUSED table1/);
  assert.ok(fs.existsSync(both) && fs.existsSync(newer), 'and a refusal changes nothing');

  // Now a dimension only the old tree has, so one branch moves whole and one merges.
  const lonely = putAt(OLD, 'DIM1_region', '1_1.bin', 'DVZ1old-b', 120);
  const dry = runTool(['--dir', cache, '--world', world, '--from', OLD, '--to', NEW, '--merge', '--dry']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would merge table1 .* 1 dimension in one rename each/,
    'a dimension the live tree has never served must move in one rename, not 124k: ' + dry.stdout);
  assert.match(dry.stdout, /would merge table1/);
  assert.ok(fs.existsSync(both) && fs.existsSync(lonely), 'a dry run moves nothing');

  const run = runTool(['--dir', cache, '--world', world, '--from', OLD, '--to', NEW, '--merge']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const movedDim = path.join(cache, NEW, 'table1', 'lit', 'DIM1_region', '1_1.bin');
  assert.ok(fs.existsSync(movedDim), `the dimension the live tree lacks moves whole: ${run.stdout}`);
  assert.deepEqual(fs.readFileSync(movedDim), Buffer.from('DVZ1old-b'), 'a rename, not a rewrite');
  const settled = path.join(cache, NEW, 'table1', 'lit', 'region', '5_6.bin');
  assert.deepEqual(fs.readFileSync(settled), Buffer.from('DVZ1newer-a'),
    'two payloads for one chunk settle by mtime: the newer decode sits closer to its region file');
  assert.ok(fs.existsSync(theirs), 'the live tree keeps what it already had');
  assert.ok(!fs.existsSync(path.join(cache, OLD)), 'the old name is gone once it is empty');
});

test('tagHash is a string hash, not a coincidence generator', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(tagHash(`C:/saves/${i}/world|12345`));
  assert.ok(seen.size > 4900, `5000 distinct inputs collapsed into ${seen.size} tags`);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
