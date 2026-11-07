#!/usr/bin/env node
// Remove the scratch a test run leaves behind when it crashes.
//
// Nothing here is data. Every pattern below is a directory some test or bake made for itself:
//   build/tmp-pack-*    pack writer temp dirs (a missing `after` hook leaked 245 of them)
//   build/newworld-*    synthetic saves from tests/region-lru.test.mjs
//   build/newregion-*   synthetic region dirs
//   build/cache-test    the payload-cache test directory
//   build/assets-test   the asset-packer test output
// It also sweeps pack writer temps older than 12 h anywhere under build/, because a bake that dies
// mid-write leaves one behind and nothing else will ever remove it.
//
// What this deliberately never touches: build/cache (warm payload cache, the server owns it),
// build/shells, build/lods, build/assets, build/ledger (baked packs), build/rescue (incident
// evidence), and any *_backup tree.
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const build = path.resolve(arg('build', 'build'));
const dry = process.argv.includes('--dry');
const PAT = [/^tmp-pack-/, /^tmp-/, /^newworld-/, /^newregion-/, /^cache-test$/, /^assets-test$/];
const staleTempMs = +(arg('stale-hours', '12') * 3600e3);

let files = 0, bytes = 0, dirs = 0;
const walk = (p) => {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isFile()) { files++; try { bytes += fs.statSync(path.join(p, e.name)).size; } catch { } }
    else if (e.isDirectory()) walk(path.join(p, e.name));
  }
};

const names = fs.existsSync(build) ? fs.readdirSync(build) : [];
for (const name of names) {
  const p = path.join(build, name);
  if (!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) continue;
  if (!PAT.some((re) => re.test(name))) continue;
  walk(p);
  dirs++;
  if (!dry) fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  console.log(`  ${dry ? 'would remove' : 'removed'} ${name}`);
}

// Orphan writer temps deeper down (a bake that died between mkdtemp and rename).
const cut = Date.now() - staleTempMs;
for (const name of fs.readdirSync(build)) {
  // Ask the skip question first: the previous pass deletes directories, and a stat of one of them
  // throws before the pattern ever gets consulted.
  if (PAT.some((re) => re.test(name))) continue;
  const p = path.join(build, name);
  if (!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^tmp-/.test(e.name)) continue;
    const q = path.join(p, e.name);
    if (fs.statSync(q).mtimeMs > cut) continue;
    walk(q); dirs++;
    if (!dry) fs.rmSync(q, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log(`  ${dry ? 'would remove' : 'removed'} ${name}/${e.name} (older than ${arg('stale-hours', 12)} h)`);
  }
}

console.log(`${dry ? 'scratch present' : 'reaped'}: ${dirs} dirs, ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
