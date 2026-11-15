// The server adopting a payload cache that belongs to a save it already serves, under a name it no longer
// uses. This exists because of a measured mistake, not a hypothetical: the cache identity's hash used to
// include the name, so `--world-tag darkrpg-world` on one boot and the `--worlds` folder's slug `darkrpg`
// on the next were two directories, and 627 579 decoded chunks (2.3 GB, an afternoon of CPU) sat in the
// one nothing asked for while the live world re-decoded and the pruner called the old tree "a save this
// server does not serve" and deleted it. The hash is the save now (resolved directory + seed), so the
// adoption below is a rename with a proof behind it. See server/cache-adopt.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worldTagFor } from '../shared/world-tag.mjs';
import { adoptCacheTag, tagHashOf } from '../server/cache-adopt.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-adopt-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { } });

/** A payload at its full depth: save tag, state table, light generation, dimension, chunk. */
function put(cache, tag, name, body, ageMin) {
  const p = path.join(cache, tag, 'table1', 'lit', 'region', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(body));
  const t = new Date(Date.now() - ageMin * 60e3);
  fs.utimesSync(p, t, t);
  return p;
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p).toString() : null);

// Two names an operator really does produce for one save: a hand-picked `--world-tag`, and the folder's
// slug in a `--worlds` root. Same directory, same seed - so the hash half is the same, by construction.
const DIR = '/srv/mcmap/saves/dark/world';
const SEED = '1234567890123456789';
const LIVE = worldTagFor({ dir: DIR, seed: SEED, override: 'darkrpg' });
const OLD = worldTagFor({ dir: DIR, seed: SEED, override: 'darkrpg-world' });

test('a payload tree this save owns under another name is renamed, not re-decoded', () => {
  assert.equal(tagHashOf(LIVE), tagHashOf(OLD), 'the hash half is the save, so adoption has something to prove');
  const cache = path.join(tmp, 'one-name');
  put(cache, OLD, '3_4.bin', 'DVZ1older', 600);
  put(cache, OLD, '3_5.bin', 'DVZ1older2', 600);
  const foreign = worldTagFor({ dir: '/srv/mcmap/saves/other/world', seed: SEED, override: 'other' });
  put(cache, foreign, '1_1.bin', 'DVZ1someoneelse', 5);
  const said = [];
  const r = adoptCacheTag({ cacheDir: cache, worldTag: LIVE, keep: [], log: (m) => said.push(m) });
  assert.equal(r.adopted.length, 1, 'exactly the one tree belongs to this save: ' + JSON.stringify(r.adopted));
  assert.equal(r.adopted[0].payloads, 2);
  assert.equal(read(path.join(cache, LIVE, 'table1', 'lit', 'region', '3_4.bin')), 'DVZ1older',
    'the payload arrives byte for byte - this is a rename, never a rewrite');
  assert.ok(!fs.existsSync(path.join(cache, OLD)), 'the old name is not left behind to confuse the next boot');
  assert.equal(read(path.join(cache, foreign, 'table1', 'lit', 'region', '1_1.bin')), 'DVZ1someoneelse',
    'a different save that happens to sit in the same cache root is not touched');
  assert.match(said.join('\n'), /is this save under another name/,
    'and the boot log says what it moved, because a silent rename of 600k files is not an honest log');
  const again = adoptCacheTag({ cacheDir: cache, worldTag: LIVE, keep: [], log: () => {} });
  assert.equal(again.adopted.length, 0, 'a normal boot adopts nothing');
});

test('a tree another world on this box claims is left alone, and --dry changes nothing', () => {
  const cache = path.join(tmp, 'claimed');
  const here = worldTagFor({ dir: '/srv/a/world', seed: '1', override: 'a' });
  const there = worldTagFor({ dir: '/srv/a/world', seed: '1', override: 'a-copy' });
  put(cache, there, '7_7.bin', 'DVZ1mine', 600);
  const dry = adoptCacheTag({ cacheDir: cache, worldTag: here, keep: [there], dry: true, log: () => {} });
  assert.equal(dry.adopted.length, 0, 'a keep-list entry is another world saying "that one is mine"');
  assert.ok(fs.existsSync(path.join(cache, there, 'table1', 'lit', 'region', '7_7.bin')));
  const run = adoptCacheTag({ cacheDir: cache, worldTag: here, keep: [there], log: () => {} });
  assert.equal(run.adopted.length, 0, 'and the same rule applies when it is not dry');
  assert.ok(fs.existsSync(path.join(cache, there)));
});

test('when both names already hold payloads they merge, and the newer payload wins', () => {
  const cache = path.join(tmp, 'both');
  const older = put(cache, OLD, '5_6.bin', 'DVZ1older', 600);
  put(cache, OLD, '8_8.bin', 'DVZ1only-old', 600);
  const newer = put(cache, LIVE, '5_6.bin', 'DVZ1newer', 5);
  const r = adoptCacheTag({ cacheDir: cache, worldTag: LIVE, keep: [], log: () => {} });
  assert.equal(r.adopted.length, 1);
  assert.ok(r.adopted[0].merged, 'the merge is reported as a merge');
  const live = path.join(cache, LIVE, 'table1', 'lit', 'region');
  assert.equal(read(path.join(live, '5_6.bin')), 'DVZ1newer',
    'the newer payload is the one decoded closer to its region file, so it is the one to keep');
  assert.equal(read(path.join(live, '8_8.bin')), 'DVZ1only-old', 'the chunk only one side had arrives anyway');
  assert.ok(!fs.existsSync(path.join(cache, OLD)), 'the old name is gone once it is empty');
  assert.ok(!fs.existsSync(older), 'and its payload file moved rather than being copied');
});

test('nothing is adopted when the cache root, the tag, or the tree is not there', () => {
  const cache = path.join(tmp, 'empty');
  fs.mkdirSync(path.join(cache, 'junk'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'junk', 'note.txt'), 'not a payload tree');
  const r = adoptCacheTag({ cacheDir: cache, worldTag: LIVE, keep: [], log: () => {} });
  assert.equal(r.adopted.length, 0, 'a directory with no lit/nolight under it is not this save\'s cache');
  assert.ok(fs.existsSync(path.join(cache, 'junk', 'note.txt')));
  assert.equal(adoptCacheTag({ cacheDir: path.join(tmp, 'nope'), worldTag: LIVE }).adopted.length, 0);
  assert.equal(adoptCacheTag({ cacheDir: cache, worldTag: '' }).adopted.length, 0);
});
