// A patch runner that cannot truncate a file by accident.
//
//   node tools/patchfile.mjs <file> <spec.json> [--max-shrink N]
//
// spec.json is {"replace": [{"old": "...", "new": "...", "count": 1}, ...]}.
//
// Why this exists: an ad-hoc whole-file Python patch once collapsed a 175 KB viewer to 672 bytes, and
// the repo had no git. The bug was a helper called as rep(anchor, anchor, text) - the subject was the
// anchor, so the "file" became the replacement text. This runner cannot do that: it asserts every
// pattern occurs the expected number of times, refuses to write anything that shrank more than
// allowed, syntax-checks a temp copy, and only then renames over the original.
//
// Line endings are preserved: patterns are matched against a LF-normalised copy, and the result is
// written back with the file's own ending (web/js/main.js is CRLF, and a mixed file is a mess).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const file = argv[0];
const specPath = argv[1];
if (!file || !specPath) { console.error('usage: node tools/patchfile.mjs <file> <spec.json>'); process.exit(2); }
// The absent-flag case has to be 0, not argv[0]: indexOf returns -1, so the old expression read
// the *file name* and turned MAX_SHRINK into NaN, and `shrink > NaN` is false for every size.
// The guard that exists to stop a truncated write had itself stopped working.
const shrinkFlag = argv.indexOf('--max-shrink');
const MAX_SHRINK = shrinkFlag >= 0 ? +(argv[shrinkFlag + 1] ?? 0) : 0;

const raw = fs.readFileSync(file);
const CRLF = raw.toString('utf8').includes('\r\n');
const src = raw.toString('utf8').replace(/\r\n/g, '\n');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

if (!(spec.replace ?? []).length && !(spec.expect ?? []).length) {
  // A spec whose top-level key is misspelled applied nothing and used to print
  // `patched ... 0 replacement(s)`, which reads like success.
  console.error(`spec has no "replace" or "expect" entries (keys: ${Object.keys(spec).join(', ')})`);
  process.exit(1);
}
let t = src;
for (const [i, r] of (spec.replace ?? []).entries()) {
  const n = t.split(r.old).length - 1;
  if (n !== (r.count ?? 1)) {
    console.error(`replace #${i}: found ${n} occurrence(s), expected ${r.count ?? 1}\n  old: ${JSON.stringify(r.old.slice(0, 120))}`);
    process.exit(1);
  }
  t = t.split(r.old).join(r.new);
}
for (const [i, r] of (spec.expect ?? []).entries()) {
  const n = t.split(r.need).length - 1;
  if (n < (r.min ?? 1)) { console.error(`expect #${i}: ${JSON.stringify(r.need.slice(0, 80))} appears ${n} time(s)`); process.exit(1); }
}
const out = CRLF ? t.replace(/\n/g, '\r\n') : t;
const shrink = Buffer.byteLength(raw) - Buffer.byteLength(out);
if (shrink > MAX_SHRINK) {
  console.error(`refusing to write: ${Buffer.byteLength(raw)} -> ${Buffer.byteLength(out)} bytes (shrink ${shrink} > ${MAX_SHRINK})`);
  process.exit(1);
}
// The temp copy must keep the original extension, or `node --check` cannot tell ESM from CJS.
const tmp = `${file}.patched${path.extname(file)}`;
fs.writeFileSync(tmp, out);
if (/\.(js|mjs|cjs)$/.test(file)) {
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) {
    fs.unlinkSync(tmp);
    console.error(`syntax check failed, original untouched:\n${e.stderr?.toString() ?? e.message}`);
    process.exit(1);
  }
}
fs.renameSync(tmp, file);
console.log(`patched ${file}: ${Buffer.byteLength(raw)} -> ${Buffer.byteLength(out)} bytes, `
  + `${(spec.replace ?? []).length} replacement(s), ${CRLF ? 'CRLF' : 'LF'} kept`);
