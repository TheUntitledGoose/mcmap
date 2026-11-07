// trimCache: the "give my disk back" path. The server's own sweep only looks inside the generation it
// is writing, so this is what drains a pile of probe residue - and it must never eat the warm end.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trimCache } from '../server/cache-prune.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-trim-'));
const now = Date.now();

// Two generations of the live shape, plus markers (0-byte files cost an inode and free nothing).
const put = (tag, light, name, size, ageMin) => {
  const p = path.join(root, tag, light, 'region', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  const t = new Date(now - ageMin * 60e3);
  fs.utimesSync(p, t, t);
  return p;
};
const cold = [], warm = [];
for (let i = 0; i < 10; i++) cold.push(put('oldtag', 'lit', `c${i}.bin`, 1000, 3000 + i));
for (let i = 0; i < 10; i++) warm.push(put('newtag', 'lit', `w${i}.bin`, 1000, i));
const marker = put('oldtag', 'lit', 'm.bin', 0, 5000);

test('over budget, the oldest payload goes and the newest survives', () => {
  const r = trimCache(root, 12000);          // 20 KB of payload, ask for 12 KB
  assert.ok(r.gone >= 8, `expected several files gone, got ${r.gone}`);
  assert.ok(r.freed >= 7000, `expected >= 7000 bytes freed, got ${r.freed}`);
  const left = warm.filter((p) => fs.existsSync(p)).length;
  assert.ok(left >= 8, `the warm end should mostly survive: ${left}/10`);
  const total = warm.concat(cold).reduce((s, p) => s + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
  assert.ok(total <= 12000, `cache still holds ${total} over a 12000 budget`);
  assert.equal(r.byTag.length, 2, 'two generations measured');
  assert.ok(r.byTag[0].bytes >= r.byTag[1].bytes, 'byTag comes back biggest first');
});

test('a zero-byte marker is deleted before any payload', () => {
  assert.ok(!fs.existsSync(marker), 'the 5000-minute-old marker should have gone first');
});

test('under budget it changes nothing', () => {
  const before = fs.readdirSync(path.join(root, 'newtag', 'lit', 'region')).length;
  const r = trimCache(root, 1e9);
  assert.equal(r.gone, 0, 'no deletions when under budget');
  assert.equal(r.freed, 0);
  assert.equal(fs.readdirSync(path.join(root, 'newtag', 'lit', 'region')).length, before);
});

test('--dry reports the same numbers and deletes nothing', () => {
  const live = fs.readdirSync(path.join(root, 'oldtag', 'lit', 'region')).length;
  const r = trimCache(root, 1000, { dry: true });
  assert.ok(r.gone > 0, 'the dry run should still find work');
  assert.equal(fs.readdirSync(path.join(root, 'oldtag', 'lit', 'region')).length, live,
    'a dry run must leave the tree exactly as it was');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));
