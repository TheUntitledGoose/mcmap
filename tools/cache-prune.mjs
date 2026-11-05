#!/usr/bin/env node
/** Delete payload-cache generations the server cannot read. See server/cache-prune.mjs. */
import path from 'node:path';
import { pruneCache } from '../server/cache-prune.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const root = path.resolve(arg('dir', 'build/cache'));
const dry = process.argv.includes('--dry');
const keep = (arg('keep', '') || '').split(',').filter(Boolean);
const keepHours = +arg('keep-hours', '24');

console.log(`cache ${root}${dry ? ' (dry run)' : ''}`);
const t0 = Date.now();
const r = pruneCache(root, { keepTags: keep, keepHours, dry, log: (m) => console.log('  ' + m) });
const gb = (r.bytes / 1e9).toFixed(2);
console.log(`${dry ? 'reachable residue' : 'freed'}: ${r.files} files, ${gb} GB in ${r.removed.length} trees ` +
  `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
