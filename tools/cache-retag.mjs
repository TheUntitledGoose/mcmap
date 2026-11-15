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
 * The other direction, and the one that saves an afternoon: the cache NAME moves while the save does not.
 * The identity is a name plus a hash of that name and the seed, so `--world-tag darkrpg-world` on one boot
 * and the folder's slug `darkrpg` on the next are two directories for one save, and the 627k warm payloads
 * are sitting in the one nothing asks for. The pruner calls that unreachable and deletes it (it warns and
 * refuses since the pairing was added, but it is still not where the server reads). `--from` moves it:
 *
 *   node tools/cache-retag.mjs --dir build/cache-wroot --from darkrpg-world.8f192217 \
 *        --to darkrpg.0939c5d0 --merge            # --to-dir if the two trees are in different roots
 *
 * A state-table tree the destination does not have yet moves whole - one `rename` for a hundred thousand
 * files. Where both sides have the same table, files settle by mtime, the newer payload winning: it was
 * decoded closer to the region file, and that is the same rule the per-chunk staleness check uses.
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
import { worldTagFor, isWorldTag } from '../shared/world-tag.mjs';
import { levelSeed } from '../server/world-dims.mjs';
import { canonicalDir } from '../server/fs-canon.mjs';
import { bins, mergeCacheTree as mergeTree } from '../server/cache-move.mjs';

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

// Payload walking and tree merging come from server/cache-move.mjs: the server performs the same move
// by itself at boot (server/cache-adopt.mjs), and two copies of "newer payload wins" is how one of
// them drifts. (Lines 54-126 of the previous file.)

const seed = levelSeed(world);
if (flag('print-tag')) {
  console.log(worldTagFor({ dir: canonicalDir(world), seed, override: arg('tag', '') }));
  console.error(`  world ${world}  seed ${seed || '(unread from level.dat)'}  dims read from ${path.join(world, 'region')}`);
  process.exit(0);
}

// The identity the SERVER computes: a resolved directory, not a spelled one, so the same save reached a
// different way has one cache and this tool moves a tree INTO it rather than beside it.
const tag = worldTagFor({ dir: canonicalDir(world), seed, override: arg('tag', '') });
const dry = flag('dry');
const merge = flag('merge');
console.log(`cache ${dir}`);
console.log(`world ${world}  seed ${seed || '(none readable)'}  ->  tag ${tag}${dry ? '  (dry run)' : ''}`
  + (merge ? '  (merge where a tree already exists)' : ''));

if (!fs.existsSync(dir)) { console.log('nothing to do: no cache directory'); process.exit(0); }

// ---- a save whose cache NAME moved: the tree is already one level deep, only the name is wrong ------
const fromName = arg('from', '');
if (fromName) {
  const toTag = arg('to', tag);
  const toRoot = path.resolve(arg('to-dir', dir));
  const srcRoot = path.join(dir, fromName);
  const dstRoot = path.join(toRoot, toTag);
  if (!fs.existsSync(srcRoot)) { console.error(`no ${srcRoot} to move from`); process.exit(2); }
  if (srcRoot === dstRoot) { console.error('--from and --to name the same tree'); process.exit(2); }
  if (!isWorldTag(toTag)) { console.error(`--to ${toTag} is not a legal cache directory name`); process.exit(2); }
  console.log(`  from ${srcRoot}`);
  console.log('    to ' + dstRoot + (srcRoot === dstRoot ? ' (same tree)' : '')
    + (merge ? '  (merge: newer payload wins)' : ''));
  const st = { moved: 0, clashed: 0, newerKept: 0, failed: 0 };
  let whole = 0, merged = 0, refused = 0, payloads = 0;
  for (const t of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (!t.isDirectory()) continue;
    const srcT = path.join(srcRoot, t.name), dstT = path.join(dstRoot, t.name);
    if (!hasLight(srcT)) { console.log(`  skip ${t.name}: no lit/nolight generation under it`); continue; }
    const n = bins(srcT).length;
    payloads += n;
    if (!fs.existsSync(dstT)) {
      if (!dry) {
        try {
          fs.mkdirSync(path.dirname(dstT), { recursive: true });
          fs.renameSync(srcT, dstT);
        } catch (e) { st.failed++; console.error(`  could not move ${t.name}: ${e.message}`); continue; }
      }
      whole++;
      console.log(`  ${dry ? 'would move' : 'moved'} ${t.name} whole - ${n} payloads in one rename`);
      continue;
    }
    if (!merge) {
      refused++;
      console.error(`  REFUSED ${t.name}: ${dstT} already holds payloads for the same state table. Same save,`
        + ' same table: the bytes are interchangeable and the newer payload wins. If that is what this is,'
        + ' re-run with --merge; if it is not, the two saves must not share a directory - pick another --to.');
      continue;
    }
    const before = st.whole || 0;
    mergeTree(srcT, dstT, dry, st);
    merged++;
    const wd = (st.whole || 0) - before;
    console.log(`  ${dry ? 'would merge' : 'merged'} ${t.name} into ${toTag}/${t.name} - ${n} payloads`
      + (wd ? `, ${wd} ${wd === 1 ? 'dimension' : 'dimensions'} in one rename each` : ''));
  }
  if (!dry && !refused && !st.failed) { try { fs.rmSync(srcRoot, { recursive: true, force: true }); } catch { } }
  console.log(`${dry ? 'would move' : 'moved'} ${payloads} payloads from ${fromName} to ${toTag}: `
    + `${whole} state-table ${whole === 1 ? 'tree' : 'trees'} whole, ${merged} merged file by file, ${refused} refused`);
  if (st.clashed) {
    console.log(`  ${st.clashed} chunks existed on both sides: ${st.newerKept} kept the destination's newer payload,`
      + ` ${st.moved} replaced it`);
  }
  if (st.failed) console.error(`  ${st.failed} payloads could not be moved (permissions? in use?)`);
  process.exit(refused || st.failed ? 2 : 0);
}

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
