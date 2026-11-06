// The patch runner exists because a hand-written patch once destroyed a 175 KB file. It is only
// worth trusting if a spec that matches nothing fails loudly instead of printing "patched".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../tools/patchfile.mjs', import.meta.url));

function run(file, specObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchfile-'));
  const src = path.join(dir, 'target.js');
  fs.writeFileSync(src, 'const a = 1;\nconst b = 2;\n');
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify(specObj));
  let out, code = 0;
  try {
    out = execFileSync(process.execPath, [TOOL, src, spec], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status;
  }
  const after = fs.readFileSync(src, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, code, after };
}

test('a spec with the wrong top-level key is an error, not a no-op', () => {
  const r = run(null, { items: [{ old: 'const a = 1;', new: 'const a = 9;' }] });
  assert.notEqual(r.code, 0, 'exit code');
  assert.match(r.out, /no "replace" or "expect"/);
  assert.equal(r.after, 'const a = 1;\nconst b = 2;\n', 'the file is untouched');
});

test('a pattern that does not match exactly once stops the run', () => {
  const r = run(null, { replace: [{ old: 'const zzz = 1;', new: 'x', count: 1 }] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /found 0 occurrence\(s\)/);
  assert.equal(r.after, 'const a = 1;\nconst b = 2;\n');
});

test('a real replacement is applied and reported', () => {
  const r = run(null, { replace: [{ old: 'const a = 1;', new: 'const a = 9;', count: 1 }] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 replacement/);
  assert.equal(r.after, 'const a = 9;\nconst b = 2;\n');
});

test('an output that shrank too far is refused', () => {
  const r = run(null, { replace: [{ old: 'const a = 1;\nconst b = 2;', new: '', count: 1 }], });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /refusing to write/);
  assert.equal(r.after, 'const a = 1;\nconst b = 2;\n');
});

test('a replacement written with the wrong key names fails loudly, not cryptically', () => {
  const r = run(null, { replace: [{ find: 'const a = 1;', replace: 'const a = 9;' }] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /needs string .old. and .new./);
  assert.equal(r.after, 'const a = 1;\nconst b = 2;\n');
});
