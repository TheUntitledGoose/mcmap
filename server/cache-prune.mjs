/**
 * Payload-cache housekeeping.
 *
 * The live key is `cacheDir/<worldTag>/<tableTag>/<lit|nolight>/<dimKey>/<cx>_<cz>.bin` (world-service
 * `#cachePath`). Every format bump - the state-id table tag, then the light tag, then the level saying
 * which SAVE it is - leaves the previous generation sitting in the same directory tree, unreachable by
 * construction. This save collected 1.33 M such files: a 3.6 GB world turned into a 36 GB cache without a
 * single byte of new world data. Nothing here is data: the cache is saved CPU, and the whole world
 * re-decodes in ~25 minutes.
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
 *
 * `byTag` groups by the first two directory levels - `<worldTag>/<tableTag>` - because since the world
 * level landed, that is the pair worth asking about: which save, which state table.
 */
export function trimCache(root, maxBytes, { dry = false, log = () => {} } = {}) {
  if (!fs.existsSync(root)) return { files: 0, bytes: 0, freed: 0, gone: 0, byTag: [] };
  const files = [];
  let total = 0;
  const walk = (d, tag, depth = 0) => {
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ent) {
      const p = path.join(d, e.name);
      const t = tag === null ? e.name : (depth < 2 ? `${tag}/${e.name}` : tag);
      if (e.isDirectory()) { walk(p, t, depth + 1); continue; }
      try { const st = fs.statSync(p); files.push([p, st.mtimeMs, st.size, t ?? '?']); total += st.size; } catch { }
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
 * The tree has four directory levels - save, state table, light, dimension - and every level ever added
 * created a tree that still looks plausible one level up:
 *
 *   pre-world:   a top-level dir that itself contains `lit`/`nolight`. That is the layout from before the
 *                cache knew which SAVE a payload came from, and reading it is the bug that level exists
 *                to fix: two saves with the same mod set answer each other's chunks. Age-pruned, so a
 *                migration in progress (tools/cache-retag.mjs) is not eaten by a boot.
 *   bad tag:     a child of a save dir that has no light level under it, or a child of a table dir that
 *                is not itself a light tag.
 *   stale save:  a save dir nothing has been written into for `keepHours`, unless named in `keepWorlds`.
 *                This is what a removed world's cache is: nobody will ever read it again. When
 *                `keepWorlds` is non-empty the list IS the answer - the server knows which worlds it
 *                serves, and a save that is not in it is dead whatever its timestamps say. Run the tool by
 *                hand with no list and only the age rule applies.
 *   stale tag:   a table dir with nothing written for `keepHours`. Same deal with `keepTags`: a non-empty
 *                list means every other table belongs to an atlas that no longer exists.
 *
 * `dry` reports and changes nothing.
 */
export function pruneCache(root, { keepTags = [], keepWorlds = [], keepHours = 24, dry = false, log = () => {} } = {}) {
  if (!fs.existsSync(root)) return { removed: [], files: 0, bytes: 0 };
  const keep = new Set(keepTags);
  const keepWorld = new Set(keepWorlds);
  const out = { removed: [], files: 0, bytes: 0 };
  const rm = (dir, why) => {
    const m = measure(dir);
    out.removed.push({ dir, why, ...m });
    out.files += m.files; out.bytes += m.bytes;
    log(`${dry ? 'would delete' : 'deleting'} ${dir} — ${m.files} files, ` +
      `${(m.bytes / 1e9).toFixed(2)} GB (${why})`);
    if (!dry) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  const hasLight = (dir) => {
    let ent;
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    return ent.some((s) => s.isDirectory() && LIGHTS.has(s.name));
  };
  const stale = (dir, depth) => (Date.now() - newestMtime(dir, depth)) / 3.6e6 > keepHours;
  const namedSaves = keepWorld.size > 0;
  const namedTables = keep.size > 0;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (!e.isDirectory()) { if (e.name.endsWith('.bin')) rm(p, 'stray file'); continue; }
    if (hasLight(p)) { rm(p, 'pre-world layout: no save level, so its payloads belong to every save at once'); continue; }
    // A save this server does not serve: one walk, one delete, and no per-table work inside a tree that
    // is going away anyway.
    if (!keepWorld.has(e.name) && namedSaves) { rm(p, 'a save this server does not serve'); continue; }
    for (const t of fs.readdirSync(p, { withFileTypes: true })) {
      const tp = path.join(p, t.name);
      if (!t.isDirectory()) { rm(tp, `stray file under a save tag: ${t.name}`); continue; }
      if (!hasLight(tp)) { rm(tp, `not a state-id table tag: ${t.name}`); continue; }
      for (const l of fs.readdirSync(tp, { withFileTypes: true })) {
        const lp = path.join(tp, l.name);
        if (l.isDirectory() && !LIGHTS.has(l.name)) rm(lp, `not a light tag: ${l.name}`);
      }
      if (!keep.has(t.name) && (namedTables || stale(tp, 2))) {
        rm(tp, namedTables ? `state-id table the running atlas is not: ${t.name}`
          : `state-id table untouched for ${keepHours}+ h`);
        continue;
      }
      for (const l of fs.readdirSync(tp, { withFileTypes: true })) {
        const lp = path.join(tp, l.name);
        if (l.isDirectory() && !LIGHTS.has(l.name)) rm(lp, `not a light tag: ${l.name}`);
      }
    }
    let left = [];
    try { left = fs.readdirSync(p); } catch { continue; }
    if (!left.length) { rm(p, 'left empty by the tag sweep'); continue; }
    if (!keepWorld.has(e.name) && stale(p, 3)) rm(p, `nothing written for this save in ${keepHours}+ h`);
  }
  return { removed: out.removed, dirs: out.removed.length, files: out.files, bytes: out.bytes };
}
