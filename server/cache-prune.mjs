/**
 * Payload-cache housekeeping.
 *
 * The live key is `cacheDir/<tableTag>/<lit|nolight>/<dimKey>/<cx>_<cz>.bin` (world-service
 * `#cachePath`). Every format bump - the state-id table tag, then the light tag - leaves the previous
 * generation sitting in the same directory tree, unreachable by construction. This save collected
 * 1.33 M such files: a 3.6 GB world turned into a 36 GB cache without a single byte of new world
 * data. Nothing here is data: the cache is saved CPU, and the whole world re-decodes in ~25 minutes.
 */
import fs from 'node:fs';
import path from 'node:path';

const LIGHTS = new Set(['lit', 'nolight']);

function newestMtime(dir, depth = 2) {
  let best = 0;
  const walk = (d, k) => {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const p = path.join(d, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs > best) best = st.mtimeMs;
      if (e.isDirectory() && k > 0) walk(p, k - 1);
    }
  };
  walk(dir, depth);
  return best;
}

/** Count files and bytes under a path (a cache tree is a few hundred thousand small files). */
export function measure(dir) {
  let files = 0, bytes = 0, dirs = 0;
  const walk = (d) => {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { dirs++; walk(p); continue; }
      try { const st = fs.statSync(p); files++; bytes += st.size; } catch { /* raced */ }
    }
  };
  walk(dir);
  return { files, bytes, dirs };
}

/**
 * Trim the cache to a byte budget, oldest first, across every generation.
 *
 * The server's own sweep (`WorldService.sweepCacheBudget`) only ever looks inside the generation it is
 * writing, and it only fires above `--cache-max-gb`. This is the other direction: "I want my disk back",
 * run by hand, and it walks every tag so a month of probe sweeps drains too. Zero-byte files go first
 * (an inode that frees no bytes), then the oldest payload - which is also what drains a generation the
 * running scheme no longer reads.
 */
export function trimCache(root, maxBytes, { dry = false, log = () => {} } = {}) {
  if (!fs.existsSync(root)) return { files: 0, bytes: 0, freed: 0, gone: 0, byTag: [] };
  const files = [];
  let total = 0;
  const walk = (d, tag) => {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, tag ?? e.name); continue; }
      try { const st = fs.statSync(p); files.push([p, st.mtimeMs, st.size, tag ?? '?']); total += st.size; } catch { }
    }
  };
  walk(root, null);
  const tags = new Map();
  for (const [, , sz, tag] of files) {
    const t = tags.get(tag) ?? { files: 0, bytes: 0 };
    t.files++; t.bytes += sz; tags.set(tag, t);
  }
  const byTag = [...tags.entries()].map(([tag, v]) => ({ tag, ...v })).sort((a, b) => b.bytes - a.bytes);
  if (total <= maxBytes) return { files: files.length, bytes: total, freed: 0, gone: 0, byTag };
  const target = maxBytes * 0.9;
  files.sort((a, b) => ((a[2] === 0 ? 0 : 1) - (b[2] === 0 ? 0 : 1)) || a[1] - b[1]);
  let freed = 0, gone = 0;
  for (const [p, , sz] of files) {
    if (sz > 0 && total - freed <= target) break;
    if (!dry) { try { fs.rmSync(p, { force: true }); } catch { continue; } }
    freed += sz; gone++;
    if (gone % 5000 === 0) log(`  ${dry ? 'would delete' : 'deleted'} ${gone} files, ${(freed / 1e6).toFixed(0)} MB`);
  }
  return { files: files.length, bytes: total, freed, gone, byTag };
}

/**
 * Remove cache subtrees the running scheme cannot read.
 *
 *   unreachable: a top-level dir with no `lit`/`nolight` inside (pre-light-tag layout), and any
 *                child of a tag dir that is not itself a light tag (that slot is the dim key).
 *   stale tag:   a tag dir with nothing written for `keepHours`, unless named in `keepTags`.
 *
 * `dry` reports and changes nothing.
 */
export function pruneCache(root, { keepTags = [], keepHours = 24, dry = false, log = () => {} } = {}) {
  if (!fs.existsSync(root)) return { removed: [], files: 0, bytes: 0 };
  const keep = new Set(keepTags);
  const out = { removed: [], files: 0, bytes: 0 };
  const rm = (dir, why) => {
    const m = measure(dir);
    out.removed.push({ dir, why, ...m });
    out.files += m.files; out.bytes += m.bytes;
    log(`${dry ? 'would delete' : 'deleting'} ${dir} — ${m.files} files, ` +
      `${(m.bytes / 1e9).toFixed(2)} GB (${why})`);
    if (!dry) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (!e.isDirectory()) { if (e.name.endsWith('.bin')) rm(p, 'stray file'); continue; }
    const subs = fs.readdirSync(p, { withFileTypes: true });
    const tagLike = subs.some((s) => s.isDirectory() && LIGHTS.has(s.name));
    if (!tagLike) { rm(p, 'no lit/nolight level: unreachable by #cachePath'); continue; }
    for (const s of subs) {
      const sp = path.join(p, s.name);
      if (s.isDirectory() && !LIGHTS.has(s.name)) rm(sp, `not a light tag: ${s.name}`);
    }
    if (!keep.has(e.name)) {
      const fresh = newestMtime(p, 2);
      const age = (Date.now() - fresh) / 3.6e6;
      if (age > keepHours) rm(p, `state-id table untouched for ${age.toFixed(0)} h`);
    }
  }
  return out;
}
