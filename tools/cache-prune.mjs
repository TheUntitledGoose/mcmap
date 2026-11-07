#!/usr/bin/env node
/**
 * Delete payload-cache generations the server cannot read, and/or trim the cache to a byte budget.
 * See server/cache-prune.mjs.
 *
 *   node tools/cache-prune.mjs [--dir build/cache] [--keep-tags a,b] [--keep-hours 24] [--dry]
 *   node tools/cache-prune.mjs --max-gb 1.5          # oldest payload first, markers first of all
 */
import path from 'node:path';
import { pruneCache, trimCache } from '../server/cache-prune.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const root = path.resolve(arg('dir', 'build/cache'));
const dry = process.argv.includes('--dry');
const keep = (arg('keep', '') || '').split(',').filter(Boolean);
const keepHours = +arg('keep-hours', '24');
const maxGb = arg('max-gb', null);

console.log(`cache ${root}${dry ? ' (dry run)' : ''}`);
const t0 = Date.now();
const r = pruneCache(root, { keepTags: keep, keepHours, dry, log: (m) => console.log('  ' + m) });
console.log(`${dry ? 'reachable residue' : 'freed'}: ${r.files} files, ${(r.bytes / 1e9).toFixed(2)} GB ` +
  `in ${r.removed.length} trees (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

if (maxGb !== null) {
  const budget = +maxGb * 1e9;
  console.log(`\ntrim to ${(+maxGb).toFixed(2)} GB (oldest first, zero-byte markers first)`);
  const t1 = Date.now();
  const s = trimCache(root, budget, { dry, log: (m) => console.log(m) });
  for (const t of s.byTag) console.log(`  ${String(t.tag).padEnd(12)} ${String(t.files).padStart(9)} files  ${(t.bytes / 1e6).toFixed(0).padStart(6)} MB`);
  console.log(`total ${(s.bytes / 1e9).toFixed(2)} GB in ${s.files} files -> ` +
    `${dry ? 'would free' : 'freed'} ${(s.freed / 1e6).toFixed(0)} MB (${s.gone} files) in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  if (s.freed === 0 && s.bytes > budget) console.log('  nothing freed: every file is newer than the budget allows, or the walk raced');
}
