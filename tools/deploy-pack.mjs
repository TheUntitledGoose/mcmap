#!/usr/bin/env node
// What has to be true before this viewer can run somewhere else, checked instead of remembered.
//
//   node tools/deploy-pack.mjs [--world DarkRPG/world] [--stage deploy] [--no-stage]
//
// Three separate questions get answered:
//   1. is the machine able to run it            (node version, three.js present)
//   2. does the save look like a save           (level.dat, region dirs, how many region files)
//   3. are the derived packs present, complete, matching the atlas, and not stale versus the save
// Staging then copies only the small part and prints the commands for the big part. build/cache is
// never staged: it is warm decode work, not data, and a fresh one costs minutes rather than correctness.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ShellPack, atlasStamp } from '../server/shell-pack.mjs';
import { OVERVIEW_MAGIC } from '../shared/chunk-format.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const WORLD = path.resolve(arg('world', 'DarkRPG/world'));
const ASSETS = path.resolve(arg('assets', 'build/assets'));
const SHELLS = path.resolve(arg('shells', 'build/shells'));
const LODS = path.resolve(arg('lods', 'build/lods'));
const LEDGER = path.resolve(arg('ledger', 'build/ledger'));
const STAGE = process.argv.includes('--no-stage') ? null : path.resolve(arg('stage', 'deploy'));

const problems = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); return cond; };

const treeInfo = (dir) => {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0, newest: 0 };
  let files = 0, bytes = 0, newest = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else { const st = fs.statSync(q); files++; bytes += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; }
    }
  };
  walk(dir);
  return { files, bytes, newest };
};
const mb = (b) => (b / 1e6).toFixed(1) + ' MB';

// ---- 1. can it run ---------------------------------------------------------------------------
const nodeMajor = +process.versions.node.split('.')[0];
ok(nodeMajor >= 18, `node ${process.versions.node}: worldd needs 18 or newer (node --test, AbortSignal.timeout)`);
const VENDOR = path.resolve('node_modules/three/build/three.module.js');
ok(fs.existsSync(VENDOR), 'three.js missing: npm install three  (worldd serves it at /vendor/)');

// ---- 2. is there a save ----------------------------------------------------------------------
ok(fs.existsSync(path.join(WORLD, 'level.dat')), `no level.dat under ${WORLD} — pass --world <dir containing region/>`);
const dimDirs = [];
for (const cand of ['region', 'DIM-1/region', 'DIM1/region']) {
  if (fs.existsSync(path.join(WORLD, cand))) dimDirs.push(cand);
}
if (fs.existsSync(path.join(WORLD, 'dimensions'))) {
  // Custom dimensions are namespaced, and the namespace can be two folders deep
  // (dimensions/spellbladenext/glassocean/region), so search for region/ rather than assume a depth.
  const scan = (dir, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const q = path.join(dir, e.name);
      if (e.name === 'region') dimDirs.push(path.relative(WORLD, q).replaceAll(path.sep, '/'));
      else scan(q, depth + 1);
    }
  };
  scan(path.join(WORLD, 'dimensions'), 1);
}
ok(dimDirs.length > 0, `${WORLD} has no region/ directory at any dimension path`);
let regionFiles = 0, regionBytes = 0, newestRegion = 0;
for (const d of dimDirs) {
  for (const f of fs.readdirSync(path.join(WORLD, d))) {
    if (!f.endsWith('.mca')) continue;
    const st = fs.statSync(path.join(WORLD, d, f));
    regionFiles++; regionBytes += st.size;
    if (st.mtimeMs > newestRegion) newestRegion = st.mtimeMs;
  }
}
notes.push(`save ${WORLD}: ${dimDirs.length} dimension(s), ${regionFiles} region files, ${mb(regionBytes)}`);
const hasLedger = fs.existsSync(path.join(WORLD, 'ledger.sqlite'));
notes.push(hasLedger ? 'block history: ledger.sqlite present' : 'block history: no ledger.sqlite, the overlay stays off');

// ---- 3. the derived packs --------------------------------------------------------------------
const atlasPath = path.join(ASSETS, 'atlas.json');
ok(fs.existsSync(atlasPath), 'build/assets/atlas.json missing: npm run census && npm run pack:assets');
const geom = fs.existsSync(path.join(ASSETS, 'geometry.bin'));
ok(geom, 'build/assets/geometry.bin missing: npm run pack:assets');
const atlas = fs.existsSync(atlasPath) ? JSON.parse(fs.readFileSync(atlasPath, 'utf8')) : { states: [] };
const stamp = fs.existsSync(atlasPath) ? atlasStamp(fs.statSync(atlasPath), atlas.states.length) : null;

const shells = treeInfo(SHELLS);
ok(shells.files > 0, 'build/shells is empty: npm run bake:shells (the far view falls back to live decode without it)');
const lods = treeInfo(LODS);
ok(lods.files > 0, 'build/lods is empty: npm run bake:lod (whole-world view rebuilds coarse tiles live)');

// A pack that does not carry the current atlas stamp is refused by the server at runtime, which looks
// like "the far layer is missing". Say it here instead.
if (stamp !== null && shells.files) {
  // Region packs and overview frames are different containers with the same stamp field; the server
  // validates each its own way (ShellPack.load, and magic+version+stamp for the overview frame), so
  // this check mirrors both instead of guessing that every .bin is a pack.
  let packs = 0, packsOk = 0, ovs = 0, ovsOk = 0;
  for (const e of fs.readdirSync(SHELLS, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.endsWith('_region')) {
      const f = fs.readdirSync(path.join(SHELLS, e.name)).find((x) => x.endsWith('.bin'));
      if (!f) continue;
      packs++; packsOk += ShellPack.load(path.join(SHELLS, e.name, f), stamp) ? 1 : 0;
    } else if (e.isFile() && /^overview-.*\.bin$/.test(e.name)) {
      const b = fs.readFileSync(path.join(SHELLS, e.name));
      ovs++;
      ovsOk += b.subarray(0, 8).toString('ascii') === OVERVIEW_MAGIC && b.readUInt32LE(12) === stamp ? 1 : 0;
    }
  }
  ok(packsOk === packs && ovsOk === ovs,
    `pack stamp mismatch: ${packsOk}/${packs} region packs and ${ovsOk}/${ovs} overview frames match atlas stamp ${stamp} — re-run bake:shells and bake:lod`);
  notes.push(`${packs} region packs + ${ovs} overview frames against atlas stamp ${stamp}: ${packsOk + ovsOk}/${packs + ovs} match`);
}

const led = treeInfo(LEDGER);
if (led.files) {
  const exp = path.join(LEDGER, 'actions.bin');
  const packs = fs.readdirSync(LEDGER).filter((f) => f.endsWith('.ledpack'));
  if (fs.existsSync(exp)) {
    const newestPack = Math.max(...packs.map((f) => fs.statSync(path.join(LEDGER, f)).mtimeMs), 0);
    ok(fs.statSync(exp).mtimeMs <= newestPack, 'ledger packs older than actions.bin: npm run bake:ledger');
  }
  notes.push(`ledger: ${packs.length} pack(s), ${mb(packs.reduce((s, f) => s + fs.statSync(path.join(LEDGER, f)).size, 0))} (actions.bin ${mb(fs.existsSync(exp) ? fs.statSync(exp).size : 0)} is a build input, not shipped)`);
}

// Bakes are not incremental per chunk, so a save newer than the packs means the far view is a picture
// of yesterday.
if (shells.newest && newestRegion > shells.newest + 60e3) {
  notes.push(`WARNING: regions changed after the last bake (${new Date(newestRegion).toISOString()} > pack ${new Date(shells.newest).toISOString()}) — re-run bake:shells/bake:lod`);
}

// ---- stage ----------------------------------------------------------------------------------
const SRC = ['server', 'shared', 'web', 'tools', 'tests', 'package.json', 'README.md', 'PLAN.md', 'HANDOFF.md'];
const total = regionBytes + shells.bytes + lods.bytes + led.bytes;
const sizeOf = (p) => (fs.existsSync(p) && fs.statSync(p).isFile() ? fs.statSync(p).size : treeInfo(p).bytes);
notes.push(`ship size: source ${mb(SRC.reduce((s, d) => s + sizeOf(path.resolve(d)), 0))} + packs ${mb(shells.bytes + lods.bytes + led.bytes)} + save ${mb(regionBytes)} = ${mb(total)}`);
notes.push('not shipped: build/cache (warm payload cache — it rebuilds), DarkRPG/mods (only bake:assets needs them), node_modules (npm install)');

if (STAGE) {
  fs.mkdirSync(STAGE, { recursive: true });
  for (const d of SRC) {
    const s = path.resolve(d);
    if (!fs.existsSync(s)) continue;
    fs.rmSync(path.join(STAGE, d), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(STAGE, d)), { recursive: true });
    fs.cpSync(s, path.join(STAGE, d), { recursive: true });
  }
  for (const d of ['build/assets', 'build/shells', 'build/lods', 'build/ledger']) {
    if (!fs.existsSync(path.resolve(d))) continue;
    const out = path.join(STAGE, d);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(path.resolve(d))) {
      if (f === 'actions.bin') continue;
      const s = path.join(path.resolve(d), f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(out, f));
      else fs.cpSync(s, path.join(out, f), { recursive: true });
    }
  }
  fs.writeFileSync(path.join(STAGE, 'start.sh'),
    `#!/bin/sh\nexec node server/worldd.mjs --world ${WORLD} --host 127.0.0.1 --port ${arg('port', 8765)}\n`);
  fs.writeFileSync(path.join(STAGE, 'start.cmd'),
    `@echo off\r\nnode server\\worldd.mjs --world ${WORLD} --host 127.0.0.1 --port ${arg('port', 8765)}\r\n`);
  fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify({
    generated: new Date().toISOString(), node: process.versions.node, atlasStamp: stamp,
    world: WORLD, dimensions: dimDirs, regionFiles, regionBytes,
    shells, lods, ledger: led, problems,
  }, null, 1));
}

for (const n of notes) console.log('  ' + n);
console.log(`\n${problems.length ? 'BLOCKED' : 'READY'}: ${problems.length} problem(s)`);
for (const p of problems) console.log('  ! ' + p);
if (STAGE) {
  console.log(`\nstaged ${STAGE} (source + packs, no cache, no actions.bin)`);
  console.log('then ship the save itself:');
  console.log(`  rsync -a ${WORLD}/ you@server:/srv/worldd/world/`);
  console.log(`  rsync -a ${STAGE}/  you@server:/srv/worldd/`);
}
process.exit(problems.length ? 1 : 0);
