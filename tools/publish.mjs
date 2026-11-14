// Build a publishable tree from what git tracks, and refuse loudly if anything un-publishable is in it.
//
//   node tools/publish.mjs                      # -> ../mcmap-publish (refuses if it already exists)
//   node tools/publish.mjs --dest ../somewhere --git --message "..."
//
// The rule this encodes: **tracked is what leaves the box.** The working notes, the save, the logs, the
// jars, the cache and the skin pack are all ignored, so they are not copied - but a stale object in git
// HISTORY would still be pushed by `git push`, which is why the checks run against `git rev-list
// --objects --all` as well, and why the output tree gets a fresh single commit instead of this repo's
// history.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DEST = path.resolve(arg('dest', '../mcmap-publish'));
const doGit = argv.includes('--git');
const force = argv.includes('--force');

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const fail = (msg) => { console.error(`\npublish refused: ${msg}`); process.exit(1); };

// 0. The pseudonym mapping has to exist here, or "no real handles" cannot be checked at all.
if (!existsSync('.private/names.json')) {
  fail('.private/names.json is missing, so real player handles cannot be verified as absent. '
    + 'Restore it from your local mapping, or pass nothing and accept that this box cannot prove it is clean.');
}

// 1. No real handle in the tracked set.
let r = spawnSync(process.execPath, ['tools/pseudonymise.mjs', '--check'], { encoding: 'utf8' });
if (r.status !== 0) fail(`a tracked file still names a real player:\n${r.stdout}${r.stderr}`);

// 2. The tracked set and the whole history: save, logs, jars, faces, notes.
r = spawnSync(process.execPath, ['--test', 'tests/publish-clean.test.mjs'], { encoding: 'utf8' });
if (r.status !== 0) fail(`tests/publish-clean.test.mjs says this tree is not publishable:\n${r.stdout.slice(-2500)}`);

// 3. Copy exactly what is tracked.
const files = git(['ls-files']).split('\n').filter(Boolean);
if (existsSync(DEST)) {
  if (!force) fail(`${DEST} already exists (pass --force to replace it)`);
  rmSync(DEST, { recursive: true, force: true });
}
mkdirSync(DEST, { recursive: true });
let bytes = 0, biggest = [];
for (const f of files) {
  const to = path.join(DEST, f);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(f, to);
  const n = statSync(to).size;
  bytes += n;
  biggest.push([n, f]);
}
biggest.sort((a, b) => b[0] - a[0]);

// 4. A history of its own: one commit, so nothing this repo has ever held travels with it.
if (doGit) {
  const g = (a) => execFileSync('git', a, { cwd: DEST, encoding: 'utf8' });
  g(['init', '-b', 'main']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', arg('message',
    'a browser map viewer for a modded Minecraft Java save: Node decodes and bakes, the page holds the voxels')]);
}

console.log(`\npublished tree: ${DEST}`);
console.log(`  ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB${doGit ? ', one fresh commit' : ', no git history'}`);
console.log('  largest:');
for (const [n, f] of biggest.slice(0, 6)) console.log(`    ${(n / 1024).toFixed(0).padStart(6)} KB  ${f}`);
console.log(`
next:
  cd "${DEST}" && cp -r <this repo>/node_modules . && npm test     # 510 here, 387 with honest skips on a clone; no network
  cd "${out}" && git remote add origin git@github.com:<you>/mcmap.git && git push -u origin main`);
