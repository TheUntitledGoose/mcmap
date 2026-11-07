// tools/reap.mjs: the scratch sweep must remove what tests leak and never touch what bakes produce.
// The "never touch" half matters more than the "remove" half: this tool runs against a build/ tree
// holding 190 MB of packs and a multi-gigabyte warm cache.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/reap.mjs', import.meta.url));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-test-'));
const mk = (rel, bytes = 8) => {
  const p = path.join(root, rel);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'f.bin'), Buffer.alloc(bytes, 7));
  return p;
};

const scratch = [mk('tmp-pack-AAAA'), mk('tmp-pack-BBBB'), mk('newworld-XXXX'), mk('newregion-YYYY'), mk('cache-test'), mk('assets-test')];

// Things that look similar but are never scratch.
const keep = [mk('cache/e5d20ee9/lit/region'), mk('shells/region'), mk('lods/region'), mk('assets'),
  mk('ledger'), mk('rescue'), mk('ov_backup'), mk('shells_v2_backup'), mk('newworlds-are-not-newworld')];

// A pack writer temp that died 2 days ago, buried one level down.
const oldTemp = mk('shells/tmp-pack-OLD');
const old = Date.now() - 48 * 3600e3;
fs.utimesSync(oldTemp, new Date(old), new Date(old));
// And a fresh one: a bake that is still running.
const freshTemp = mk('shells/tmp-pack-NEW');

test('the sweep takes scratch and leaves everything else', () => {
  const out = execFileSync(process.execPath, [TOOL, '--build', root], { encoding: 'utf8' });
  for (const d of scratch) assert.ok(!fs.existsSync(d), `${path.basename(d)} should have been removed`);
  for (const d of keep) assert.ok(fs.existsSync(d), `${path.basename(d)} must survive: ${out}`);
  assert.ok(!fs.existsSync(oldTemp), 'a 48 h old pack-writer temp under shells/ is an orphan');
  assert.ok(fs.existsSync(freshTemp), 'a fresh temp may belong to a bake that is running right now');
  assert.match(out, /reaped: \d+ dirs/);
});

test('--dry removes nothing but reports the same set', () => {
  const again = mk('tmp-pack-CCCC');
  const out = execFileSync(process.execPath, [TOOL, '--build', root, '--dry'], { encoding: 'utf8' });
  assert.ok(fs.existsSync(again), 'dry run must not delete');
  assert.match(out, /tmp-pack-CCCC/);
  assert.match(out, /scratch present/);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));
