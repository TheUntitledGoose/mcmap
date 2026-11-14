// Rewrite real player handles in the tracked tree to the pseudonyms the published tree uses, or check that
// none are left. The names themselves live in `.private/names.json`, which is git-ignored: this file is
// source and says only HOW the substitution works.
//
//   node tools/pseudonymise.mjs            # rewrite tracked files in place
//   node tools/pseudonymise.mjs --check    # exit 1 and list what still carries a real handle
//
// Why: this viewer was built on a private multiplayer save. Its tests, probes and docs refer to the cast by
// handle, and a handle next to "we logged every block you changed, with coordinates" is someone else's
// personal data to publish. The pseudonyms keep the sentences readable - "player E has no profile, so the
// strip gives her the white cell" is still a true sentence about the code.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MAPFILE = '.private/names.json';
const check = process.argv.includes('--check');

if (!existsSync(MAPFILE)) {
  console.error(`${MAPFILE} is missing: nothing to substitute. It is git-ignored on purpose - keep it from`
    + ' your own copy of the server\'s player list.');
  process.exit(2);
}
const map = JSON.parse(readFileSync(MAPFILE, 'utf8')).map;
const names = Object.keys(map);
// Longest first, so a handle that contains another is replaced whole.
names.sort((a, b) => b.length - a.length);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = new RegExp(names.map(esc).join('|'), 'gi');

let touched = 0, hits = 0;
const perFile = [];
for (const f of files) {
  let raw;
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }   // unreadable (binary/deleted): skip
  const crlf = raw.includes('\r\n');
  const s = crlf ? raw.split('\r\n').join('\n') : raw;
  const n = (s.match(re) || []).length;
  if (!n) continue;
  hits += n;
  perFile.push([f, n]);
  if (check) continue;
  const out = s.replace(re, (m) => {
    const real = names.find((x) => x.toLowerCase() === m.toLowerCase());
    return map[real];
  });
  writeFileSync(f, crlf ? out.split('\n').join('\r\n') : out);
  touched++;
}

for (const [f, n] of perFile) console.log(`  ${f}: ${n}`);
if (check) {
  console.log(`${hits} real handle${hits === 1 ? '' : 's'} still in ${perFile.length} tracked file(s)`);
  process.exit(hits ? 1 : 0);
}
console.log(`pseudonymised ${hits} handle(s) across ${touched} file(s); mapping stays in ${MAPFILE}`);
