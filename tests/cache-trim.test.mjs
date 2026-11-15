// trimCache / pruneCache: the "give my disk back" path. The server's own sweep only looks inside the
// generation it is writing, so this is what drains a pile of probe residue - and it must never eat the
// warm end. The cache tree is <world>/<state table>/<generation>/<dimension>/, and a tree missing that
// first level is deleted rather than read: see tests/cache-world-tag.test.mjs for why.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimCache, pruneCache } from '../server/cache-prune.mjs';

const made = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-trim-')); made.push(d); return d; };
const now = Date.now();

// A payload file at its full depth: save, then state table, then generation, then dimension.
const put = (root, world, tag, light, name, size, ageMin) => {
  const p = path.join(root, world, tag, light, 'region', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  const t = new Date(now - ageMin * 60e3);
  fs.utimesSync(p, t, t);
  return p;
};

test('over budget, the oldest payload goes and the newest survives', () => {
  const root = mk();
  const cold = [], warm = [];
  for (let i = 0; i < 10; i++) cold.push(put(root, 'saveA', 'oldtag', 'lit', `c${i}.bin`, 1000, 3000 + i));
  for (let i = 0; i < 10; i++) warm.push(put(root, 'saveA', 'newtag', 'lit', `w${i}.bin`, 1000, i));
  const marker = put(root, 'saveA', 'oldtag', 'lit', 'm.bin', 0, 5000);

  const r = trimCache(root, 12000);          // 20 KB of payload, ask for 12 KB
  assert.ok(r.gone >= 8, `expected several files gone, got ${r.gone}`);
  assert.ok(r.freed >= 7000, `expected >= 7000 bytes freed, got ${r.freed}`);
  const left = warm.filter((p) => fs.existsSync(p)).length;
  assert.ok(left >= 8, `the warm end should mostly survive: ${left}/10`);
  const total = warm.concat(cold).reduce((s, p) => s + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
  assert.ok(total <= 12000, `cache still holds ${total} over a 12000 budget`);
  assert.equal(r.byTag.length, 2, 'two generations measured');
  assert.ok(r.byTag[0].bytes >= r.byTag[1].bytes, 'byTag comes back biggest first');
  assert.ok(r.byTag.every((b) => b.tag.includes('/')),
    'a generation is named by save and state table together, not the table alone');
  assert.ok(!fs.existsSync(marker), 'the 5000-minute-old 0-byte marker goes before any payload');
});

test('under budget it changes nothing, and --dry reports the same numbers it would have acted on', () => {
  const root = mk();
  for (let i = 0; i < 10; i++) put(root, 'saveA', 'oldtag', 'lit', `c${i}.bin`, 1000, 3000 + i);
  for (let i = 0; i < 10; i++) put(root, 'saveA', 'newtag', 'lit', `w${i}.bin`, 1000, i);
  const dirOf = (t) => path.join(root, 'saveA', t, 'lit', 'region');
  const before = fs.readdirSync(dirOf('newtag')).length;
  const r = trimCache(root, 1e9);
  assert.equal(r.gone, 0, 'no deletions when under budget');
  assert.equal(r.freed, 0);
  assert.equal(fs.readdirSync(dirOf('newtag')).length, before);

  const live = fs.readdirSync(dirOf('oldtag')).length;
  const d = trimCache(root, 1000, { dry: true });
  assert.ok(d.gone > 0, 'the dry run should still find work');
  assert.equal(fs.readdirSync(dirOf('oldtag')).length, live,
    'a dry run must leave the tree exactly as it was');
});

test('pruneCache drops the save nobody serves and keeps the one it is told about', () => {
  const root = mk();
  for (let i = 0; i < 6; i++) put(root, 'deadSave', 'table1', 'lit', `d${i}.bin`, 2000, 5 + i);
  for (let i = 0; i < 6; i++) put(root, 'liveSave', 'table1', 'lit', `k${i}.bin`, 2000, 5 + i);
  const r = pruneCache(root, { keepWorlds: ['liveSave'], keepHours: 10000, log: () => {} });
  assert.equal(r.dirs, 1, 'exactly one tree is cleared');
  assert.ok(!fs.existsSync(path.join(root, 'deadSave')),
    'a save that stopped being served must not hold its payloads forever');
  assert.match(r.removed[0].why, /does not serve/);
  assert.equal(r.files, 6, 'and it reports the file count it deleted');
  assert.ok(fs.existsSync(path.join(root, 'liveSave', 'table1', 'lit', 'region')),
    'the served save keeps its payloads whatever else goes');
});

test('a save list is the truth about which saves are alive, freshness included; without one, age decides', () => {
  const root = mk();
  // Both saves were written minutes ago: nothing about the timestamps says either is dead.
  for (let i = 0; i < 4; i++) put(root, 'served', 'table1', 'lit', `a${i}.bin`, 1000, 1 + i);
  for (let i = 0; i < 4; i++) put(root, 'retired', 'table1', 'lit', `b${i}.bin`, 1000, 1 + i);
  const guessing = pruneCache(root, { keepHours: 24, log: () => {} });
  assert.equal(guessing.dirs, 0, 'told nothing, it must not guess that a fresh tree is dead');
  assert.ok(fs.existsSync(path.join(root, 'retired')), 'so a fresh tree survives a hand run');
  const told = pruneCache(root, { keepWorlds: ['served'], keepHours: 24, log: () => {} });
  assert.equal(told.dirs, 1, 'told which worlds are live, everything else is dead weight');
  assert.ok(!fs.existsSync(path.join(root, 'retired')));
});

test('pruneCache drops a state generation it was told is not live, and keeps the one it was named', () => {
  const root = mk();
  for (let i = 0; i < 6; i++) put(root, 'saveA', 'oldtable', 'lit', `o${i}.bin`, 1500, 5 + i);
  for (let i = 0; i < 6; i++) put(root, 'saveA', 'livetab', 'lit', `n${i}.bin`, 1500, 5 + i);
  const r = pruneCache(root, { keepTags: ['livetab'], keepWorlds: ['saveA'], keepHours: 10000, log: () => {} });
  assert.equal(r.dirs, 1, 'the stale generation is reported');
  assert.ok(!fs.existsSync(path.join(root, 'saveA', 'oldtable')),
    'an old state table is dead weight once the atlas moved on');
  assert.ok(fs.existsSync(path.join(root, 'saveA', 'livetab', 'lit', 'region')));
});

test('a cache tree under an old NAME for a live save is kept, and the pruner prints the way out', () => {
  const root = mk();
  // Two names, one save: the first boot was `--world-tag oldname`, this one calls the same save by its
  // folder slug. Both spellings hash differently, so the warm payloads are in the directory nothing asks.
  for (let i = 0; i < 40; i++) put(root, 'oldname.11111111', 'e5d20ee9', 'lit', `o${i}.bin`, 3000, 200 + i);
  for (let i = 0; i < 4; i++) put(root, 'newname.22222222', 'e5d20ee9', 'lit', `n${i}.bin`, 3000, 1 + i);
  const said = [];
  const r = pruneCache(root, {
    keepWorlds: ['newname.22222222'], keepTags: ['e5d20ee9'], keepHours: 24,
    tableOwners: [['newname.22222222', ['e5d20ee9']]], log: (m) => said.push(m),
  });
  assert.equal(r.files, 0, 'nothing is deleted: those payloads belong to a save that is on this box');
  assert.equal(r.dirs, 0);
  assert.equal(r.renamed.length, 1, 'and the operator sees why a tree was spared');
  assert.equal(r.renamed[0].dir, 'oldname.11111111');
  assert.deepEqual(r.renamed[0].tables, ['e5d20ee9']);
  assert.deepEqual(r.renamed[0].wantedBy, ['newname.22222222']);
  assert.equal(r.renamed[0].files, 40);
  const hint = said.join('\n');
  assert.match(hint, /cache-retag\.mjs --dir .* --from oldname\.11111111 --to newname\.22222222 --merge/,
    'the fix has to be a command that can be pasted, not a hint: ' + hint);
  // The other half of the rule: a tree whose table belongs to no live save is still dead weight.
  for (let i = 0; i < 5; i++) put(root, 'gonebox.33333333', 'aabbccdd', 'lit', `g${i}.bin`, 3000, 3);
  const gone = pruneCache(root, {
    keepWorlds: ['newname.22222222'], keepTags: ['e5d20ee9'], keepHours: 24,
    tableOwners: [['newname.22222222', ['e5d20ee9']]], log: () => {},
  });
  assert.equal(gone.dirs, 1, 'a save that is not here and shares no table still goes');
  assert.ok(!fs.existsSync(path.join(root, 'gonebox.33333333')));
  assert.ok(fs.existsSync(path.join(root, 'oldname.11111111', 'e5d20ee9', 'lit', 'region', 'o7.bin')),
    'and the renamed one is still there, waiting to be moved');
});

test('the cache tree the code wrote before saves had identities is deleted, never read', () => {
  const root = mk();
  // <state table>/<generation>/<dimension>/<chunk>.bin: correct-looking, and ambiguous about which save.
  const p = path.join(root, 'table1', 'lit', 'region', '3_-8.bin');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(4096, 3));
  const r = pruneCache(root, { keepHours: 10000, log: () => {} });
  assert.ok(!fs.existsSync(p), 'a payload that cannot say which save it came from must not be trusted');
  assert.equal(r.dirs, 1, 'it is reported: an operator should see why a gigabyte of cache vanished');
  assert.match(r.removed[0].why, /save level/);
  assert.equal(r.files, 1);
});

after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
