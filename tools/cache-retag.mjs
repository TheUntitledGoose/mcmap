#!/usr/bin/env node
/**
 * Give an existing payload cache the save level it was written without.
 *
 * The world level (shared/world-tag.mjs) is a **rename**, not a re-decode: the payloads, their frames
 * and their state ids are unchanged, so 627k files and 1.4 GB of saved CPU move one directory deeper in
 * one `rename` per state-table tag. Booting the server without doing this reaches the same end state the
 * expensive way - the pruner reports the old tree as unreachable, deletes it, and every chunk decodes
 * again (~25 minutes for this save).
 *
 *   node tools/cache-retag.mjs [--dir build/cache] [--world DarkRPG/world] [--tag <tag>] [--dry]
 *   node tools/cache-retag.mjs --print-tag [--world DarkRPG/world]   # what the server would call it
 *
 * A destination that already exists is refused, not merged, unless `--merge` is asked for. Refusing is the
 * default because merging two cache trees is exactly how a payload decoded from one save comes to be
 * served for another; `--merge` is for the ordinary case where both trees *are* the same save and state
 * table - typically a few payloads the running server wrote after the level landed, next to 600k it did
 * not. There, a chunk file that exists on both sides is settled by mtime: the newer payload wins, because
 * the per-chunk staleness check compares a payload's mtime with its region file's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { worldTagFor } from '../shared/world-tag.mjs';
import { levelSeed } from '../server/world-dims.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes('--' + k);

const dir = path.resolve(arg('dir', 'build/cache'));
const world = arg('world', 'DarkRPG/world');
const LIGHTS = new Set(['lit', 'nolight']);

const hasLight = (p) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).some((s) => s.isDirectory() && LIGHTS.has(s.name)); }
  catch { return false; }
};

/** Payload files under a subtree. Hand-rolled: `readdirSync(dir, {recursive})` is Node 20+, and the
 *  README asks for 18. `rel` comes back with forward slashes so the mirror side can re-join it. */
function bins(p) {
  const out = [];
  const walk = (d, pre) => {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else if (e.name.endsWith('.bin')) out.push(rel);
    }
  };
  walk(p, '');
  return out;
}

/** Move one state-table tree under the world tag, file by file, settling name clashes by mtime. */
function mergeTree(from, to, dry, stat) {
  for (const rel of bins(from)) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!fs.existsSync(dst)) {
      if (!dry) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.renameSync(src, dst); } catch { stat.failed++; continue; }
      }
      stat.moved++;
      continue;
    }
    // Both sides hold a payload for the same chunk. The paths say same save, same state table, same
    // generation - so the newer file is the one decoded closer to its region file, and it wins.
    stat.clashed++;
    let a = 0, b = 0;
    try { a = fs.statSync(src).mtimeMs; b = fs.statSync(dst).mtimeMs; } catch { }
    if (a <= b) {
      if (!dry) { try { fs.rmSync(src, { force: true }); } catch { } }
      stat.newerKept++;
      continue;
    }
    if (!dry) {
      try { fs.rmSync(dst, { force: true }); fs.renameSync(src, dst); } catch { stat.failed++; continue; }
    }
  }
  if (!dry) { try { fs.rmSync(from, { recursive: true, force: true }); } catch { } }
}

const seed = levelSeed(world);
if (flag('print-tag')) {
  console.log(worldTagFor({ dir: path.resolve(world), seed, override: arg('tag', '') }));
  console.error(`  world ${world}  seed ${seed || '(unread from level.dat)'}  dims read from ${path.join(world, 'region')}`);
  process.exit(0);
}

const tag = worldTagFor({ dir: path.resolve(world), seed, override: arg('tag', '') });
const dry = flag('dry');
const merge = flag('merge');
console.log(`cache ${dir}`);
console.log(`world ${world}  seed ${seed || '(none readable)'}  ->  tag ${tag}${dry ? '  (dry run)' : ''}`
  + (merge ? '  (merge where a tree already exists)' : ''));

if (!fs.existsSync(dir)) { console.log('nothing to do: no cache directory'); process.exit(0); }

let moved = 0, kept = 0, refused = 0, files = 0;
const stat = { moved: 0, clashed: 0, newerKept: 0, failed: 0 };
for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
  const p = path.join(dir, e.name);
  if (!e.isDirectory()) continue;
  if (!hasLight(p)) { kept++; continue; }              // already a world-tag directory (or junk the pruner reports)
  const dest = path.join(dir, tag, e.name);
  const n = bins(p).length;
  if (fs.existsSync(dest)) {
    if (!merge) {
      refused++;
      console.error(`  REFUSED ${e.name}: ${dest} already exists - two cache trees holding payloads for the`
        + ' same chunk is how payloads decoded from one save get read for another. If both trees really '
        + 'are this save and this state table, re-run with --merge; otherwise retag with a different --tag.');
      continue;
    }
    if (!dry) mergeTree(p, dest, false, stat);
    files += n;
    console.log(`  ${dry ? 'would merge' : 'merged'} ${e.name} into ${tag}/${e.name}  (${n} payloads)`);
    continue;
  }
  files += n;
  if (!dry) {
    fs.mkdirSync(path.join(dir, tag), { recursive: true });
    fs.renameSync(p, dest);
  }
  moved++;
  console.log(`  ${dry ? 'would move' : 'moved'} ${e.name} -> ${tag}/${e.name}  (${n} payloads)`);
}

console.log(`${dry ? 'would move' : 'moved'} ${moved} state-table ${moved === 1 ? 'tree' : 'trees'} `
  + `(${files} payloads) under ${tag}; ${kept} already under a world tag; ${refused} refused`);
if (stat.clashed) {
  console.log(`  merged file by file: ${stat.moved} moved, ${stat.clashed} on both sides`
    + ` (newer kept ${stat.newerKept})`);
  if (stat.failed) console.error(`  ${stat.failed} could not be moved (permissions? in use?)`);
}
if (refused || stat.failed) process.exit(2);
