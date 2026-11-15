/**
 * Moving payload-cache trees, shared by `tools/cache-retag.mjs` (a human does it) and the server's
 * identity adoption (`server/cache-adopt.mjs`, which does it at boot).
 *
 * The rule that makes a move safe is the same in both places: a state-table subtree the destination
 * does not have at all moves in ONE `rename`, and where both sides hold the same chunk file the newer
 * payload wins - because the per-chunk staleness check compares a payload's mtime with its region
 * file's, so the newer decode is the one sitting closer to the truth on disk.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Payload files under a subtree, with forward-slash-relative names. Hand-rolled walk: `readdirSync`
 *  with `recursive` is Node 20+, and the README asks for 18. */
export function bins(p) {
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

/**
 * Move `from` onto `to` (which may already exist), counting into `stat`
 * `{ moved, clashed, newerKept, failed, whole }`.
 *
 * A subtree the destination does not have - a whole dimension, 124k payloads - moves in one `rename`.
 * That is not a micro-optimisation: the file-by-file path measured 409k renames over several minutes on
 * a real cache, and a dimension the live tree has never served is the common case when a save is
 * renamed rather than split.
 */
export function mergeCacheTree(from, to, dry, stat) {
  const walk = (srcDir, dstDir) => {
    if (!fs.existsSync(dstDir)) {
      const n = bins(srcDir).length;
      if (!dry) {
        try {
          fs.mkdirSync(path.dirname(dstDir), { recursive: true });
          fs.renameSync(srcDir, dstDir);
        } catch { stat.failed += n; return; }
      }
      stat.moved += n;
      stat.whole = (stat.whole || 0) + 1;
      return;
    }
    let ent;
    try { ent = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const src = path.join(srcDir, e.name), dst = path.join(dstDir, e.name);
      if (e.isDirectory()) { walk(src, dst); continue; }
      if (!e.name.endsWith('.bin')) continue;
      if (!fs.existsSync(dst)) {
        if (!dry) { try { fs.renameSync(src, dst); } catch { stat.failed++; continue; } }
        stat.moved++;
        continue;
      }
      // Both sides hold a payload for the same chunk: same save, same state table, same generation.
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
      stat.moved++;
    }
  };
  walk(from, to);
  if (!dry) { try { fs.rmSync(from, { recursive: true, force: true }); } catch { } }
}
