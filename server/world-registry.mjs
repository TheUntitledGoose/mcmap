/**
 * Which worlds this process serves, and which one a request means.
 *
 * `--worlds <root>` (`WD_WORLDS`) makes a folder of worlds:
 *
 *   <root>/<slug>/save/world/...                        the save, read-only
 *   <root>/<slug>/packs/{assets,shells,lods,ledger,skins,embed}
 *
 * That is the layout one world push installs, and the shape ONE bind mount covers, so adding a
 * world is dropping a folder: no compose edit, no stack redeploy, no new mount. The folder name is the
 * slug - what `?world=` says, what the payload cache directory is called, and what the page's dropdown
 * offers. A world whose packs are missing is still listed, with the reason it cannot render yet.
 *
 * `--world` (the single-save shape) keeps working exactly as it was: one world, `?world=` optional, and
 * today's container is unaffected. Both shapes produce the same bundle objects from `world-bundle.mjs`,
 * so the routes never learn which shape they are in.
 *
 * A request names a world with `?world=<slug>`; naming nothing means `--world-default`. An unknown slug
 * is answered with the list of what does exist - never with a silent fallback. Being shown a different
 * save than the one you asked for, with no sign of the swap, is the failure this whole arrangement
 * exists to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openWorld, findSave, findPacks, slugOk } from './world-bundle.mjs';

/**
 * Look at a worlds root without opening anything: slugs, where each save is, which packs are present.
 * Cheap enough to run at boot before any atlas is parsed, and it is what `/meta.worlds` can answer even
 * for a world that cannot render.
 */
export function discoverWorlds(root) {
  const out = { root, worlds: [], problems: [] };
  if (!root || root === 'none') { out.problems.push('no worlds root given (--worlds / WD_WORLDS)'); return out; }
  if (!fs.existsSync(root)) { out.problems.push(`no worlds root at ${root}`); return out; }
  let ent;
  try { ent = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    out.problems.push(`cannot read ${root}: ${e.message ?? e}`); return out;
  }
  for (const e of ent.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;                 // dot entries are not worlds
    if (!e.isDirectory()) continue;                        // a stray file is nobody's world
    if (!slugOk(e.name)) {
      out.problems.push(`${e.name}: not a usable slug (lowercase letters, digits, . _ -; one path segment)`);
      continue;
    }
    const dir = path.join(root, e.name);
    const save = findSave(dir);
    const packs = {
      assets: findPacks(dir, 'assets'),
      shells: findPacks(dir, 'shells'),
      lods: findPacks(dir, 'lods'),
      ledger: findPacks(dir, 'ledger'),
      skins: findPacks(dir, 'skins'),
      embed: findPacks(dir, 'embed'),
    };
    if (!save.world) {
      out.problems.push(`${e.name}: no save inside ${dir} `
        + '(wanted save/world/level.dat, world/level.dat, or level.dat)');
      continue;
    }
    out.worlds.push({ slug: e.name, dir, world: save.world, packs,
      packsHere: Object.entries(packs).filter(([, v]) => v).map(([k]) => k) });
  }
  return out;
}

/**
 * Open one discovered world. Factored out of `openWorldsRoot` because a world can also arrive later, by
 * someone dropping a folder into the root while the box is running.
 */
export function openWorldFor(w, { cache = null, cacheMaxGb = 2, defaultEmbed = '', log = () => {} } = {}) {
  return openWorld({
    slug: w.slug, dir: w.dir, cache, cacheMaxGb, worldTag: w.slug,
    // The tag came from the folder this save was dropped into, not from a flag: the boot log has to say
    // that, or an operator reading "from --world-tag darkrpg" goes hunting for a line in the stack.
    worldTagFrom: 'the folder name in the --worlds root',
    // `|| dir/packs/assets` even when absent, so the "no asset pack" sentence names the place this
    // world's pack should be rather than a generic build/assets.
    paths: { ...w.packs, assets: w.packs.assets || path.join(w.dir, 'packs', 'assets'),
      world: w.world, defaultEmbed },
    log,
  });
}

/**
 * Open every world under a root. `defaultSlug` picks what a request gets when it does not name one;
 * with more than one world and no default, this refuses to guess - a boot that quietly chose "the first
 * folder alphabetically" is how someone ends up browsing the wrong save.
 */
export function openWorldsRoot({ root, defaultSlug = '', cache = null, cacheMaxGb = 2,
  defaultEmbed = '', refreshTtlMs = 15000, log = () => {} } = {}) {
  const found = discoverWorlds(root);
  const openOpts = { cache, cacheMaxGb, defaultEmbed, log };
  const bundles = [];
  for (const w of found.worlds) {
    // The slug IS the cache identity's name (shared/world-tag.mjs): a folder called `darkrpg` keeps its
    // payloads in `cache/darkrpg.<seed hash>/...` on every box, and a different save dropped under the
    // same folder name gets a different directory.
    const b = openWorldFor(w, openOpts);
    bundles.push(b);
    if (b.problem) found.problems.push(`${w.slug}: ${b.problem.split('\n')[0]}`);
  }
  const good = bundles.filter((b) => !b.problem);
  let def = defaultSlug;
  if (!def && good.length === 1) def = good[0].slug;
  if (def && !bundles.some((b) => b.slug === def)) {
    found.problems.push(`--world-default ${def}: no such world (have: ${bundles.map((b) => b.slug).join(', ') || 'none'})`);
    def = '';
  }
  if (!def && good.length > 1) {
    found.problems.push(`more than one world and no --world-default (have: ${good.map((b) => b.slug).join(', ')})`);
  }
  const registry = new WorldRegistry({ bundles, defaultSlug: def, problems: found.problems,
    root, openOpts, refreshTtlMs, log });
  // A world that could not open at boot is not retried on every glance at the root: opening one reads its
  // level.dat and parses its atlas, and a save whose packs are simply never coming would be reparsed
  // every 15 seconds for the life of the process.
  for (const b of bundles) if (b.problem) registry.nextTry.set(b.slug, Date.now() + FAILED_RETRY_MS);
  return { registry, found };
}

// How often the worlds root may be looked at, and how soon a *miss* is allowed to look again. A miss is
// the interesting case: someone dropped a folder in a minute ago and a link names it.
const MISS_FLOOR_MS = 5000;
// A world that will not open (its asset pack has not arrived yet) is worth trying again, but not every
// 15 seconds: opening one means reading its level.dat and parsing its atlas.
const FAILED_RETRY_MS = 300000;

/** One world, named by slug, for the routes. */
export class WorldRegistry {
  constructor({ bundles = [], defaultSlug = '', problems = [], root = null, openOpts = null,
    refreshTtlMs = 15000, log = () => {} } = {}) {
    this.bySlug = new Map(bundles.map((b) => [b.slug, b]));
    this.order = bundles.map((b) => b.slug);
    this.defaultSlug = defaultSlug;
    this.problems = problems;
    // A single --world bundle has no slug of its own; it is still the world every request means.
    this.single = bundles.length === 1 && !bundles[0].slug;
    // A --worlds root can gain a save while this process runs. The registry is the thing that knows the
    // root, so it is the thing that re-looks.
    this.root = root && root !== 'none' ? root : null;
    this.openOpts = openOpts;
    this.refreshTtlMs = +(refreshTtlMs || 0) || 0;
    this.log = log;
    this.lastScan = Date.now();
    this.lastMissScan = 0;     // the last time a request for an unknown slug made the registry re-look
    this.nextTry = new Map();   // slug -> ms, when a world that failed to open is worth trying again
    this.missing = new Set();   // opened here, no longer on disk: still served, but said out loud
  }

  get multi() { return !this.single; }
  slugs() { return [...this.order]; }
  get default() { return this.single ? this.only() : (this.bySlug.get(this.defaultSlug) ?? null); }
  only() { return [...this.bySlug.values()][0]; }

  /**
   * Look at the worlds root again.
   *
   * A save arrives by someone dropping a folder onto a mounted share, so a boot-time-only listing means
   * the answer to "where is my other save" is "restart the container". `/meta` asks this on a TTL (the
   * dropdown learns) and a slug that is not here asks once immediately (a link typed a minute after the
   * copy finished works). Re-opening a world that had failed is how "its asset pack showed up later"
   * becomes a map instead of a permanent 404.
   *
   * What it does NOT do is take a world away. A folder that is briefly not there is usually a re-sync in
   * progress, and blanking someone's map because of that is worse than serving what is already open - so
   * the slug keeps working, and the fact goes in `missing` for `/meta` and the boot log to show.
   *
   * Returns null when it declined to look (too soon), so a caller can tell "nothing changed" from "I did
   * not check".
   */
  refresh({ now = Date.now(), floor = this.refreshTtlMs } = {}) {
    if (!this.root || !this.openOpts || !(floor >= 0)) return null;
    if (now - this.lastScan < floor) return null;
    this.lastScan = now;
    const found = discoverWorlds(this.root);
    const seen = new Set();
    const added = [], revived = [];
    for (const w of found.worlds) {
      seen.add(w.slug);
      const cur = this.bySlug.get(w.slug);
      if (cur && !cur.problem) continue;
      if (cur && now < (this.nextTry.get(w.slug) ?? 0)) continue;
      const b = openWorldFor(w, this.openOpts);
      if (b.problem) {
        this.nextTry.set(w.slug, now + FAILED_RETRY_MS);
        found.problems.push(`${w.slug}: ${b.problem.split('\n')[0]}`);
      } else {
        this.nextTry.delete(w.slug);
        (cur ? revived : added).push(w.slug);
      }
      this.bySlug.set(w.slug, b);
      if (!this.order.includes(w.slug)) this.order.push(w.slug);
    }
    for (const slug of [...this.bySlug.keys()]) {
      if (!seen.has(slug)) this.missing.add(slug);
      if (this.bySlug.get(slug)?.problem) found.problems.push(`${slug}: ${this.bySlug.get(slug).problem.split('\n')[0]}`);
    }
    for (const slug of seen) this.missing.delete(slug);
    this.problems = found.problems;
    for (const s of added) this.log(`world added: ${s} (found in the --worlds root while running)`);
    for (const s of revived) this.log(`world opened: ${s} (its packs arrived after boot)`);
    return { added, revived, missing: [...this.missing], problems: found.problems };
  }

  /** The world a request means: `?world=<slug>`, or the default. Null means the caller answers 404. */
  resolve(slug) {
    const s = slug === null || slug === undefined ? '' : String(slug);
    // One save: `world=` is either nothing or that save. A stale slug left in a bookmark gets the same
    // honest refusal as in a multi-world process - it is a request for a world this box does not have.
    if (this.single) return (!s || s === this.only().slug) ? this.only() : null;
    const hit = this.bySlug.get(s === '' ? this.defaultSlug : s) ?? null;
    if (hit || !s || !this.root) return hit;
    // A named slug this process has never seen: look at the root once before refusing, because the most
    // likely reason is that the save was dropped in since the last boot. Guarded by its own clock rather
    // than the TTL clock, so a boot-time scan does not blind the registry to a link typed a minute later,
    // and a stray `?world=` typo cannot turn into a readdir per request.
    const now = Date.now();
    if (now - (this.lastMissScan ?? 0) < MISS_FLOOR_MS) return null;
    this.lastMissScan = now;
    this.refresh({ now, floor: 0 });
    return this.bySlug.get(s) ?? null;
  }

  /** What to say when resolve() said null - the available slugs, never a suggestion to fall back. */
  whyMiss(slug) {
    if (this.single) {
      return `this server serves one save (${this.only().paths.world}); drop world='${slug}', or start it `
        + 'with --worlds <dir> to serve a folder of them';
    }
    const have = this.order.length ? this.order.join(', ') : '(none - every world failed to open)';
    return `unknown world '${slug ?? ''}'; this server serves: ${have}`
      + (this.defaultSlug ? `. Omit world= for '${this.defaultSlug}'.` : '');
  }

  list() {
    return [...this.bySlug.values()].map((b) => (b.problem
      ? { slug: b.slug, label: b.slug, problem: b.problem.split('\n')[0] }
      : b.facts()));
  }

  /** Stats summed across worlds, for the heartbeat line (one process, several saves). */
  totals() {
    const t = {};
    let packs = 0, open = 0;
    for (const b of this.bySlug.values()) {
      if (b.problem) continue;
      open++;
      packs += b.svc.packs.size;
      for (const [k, v] of Object.entries(b.svc.stats)) {
        if (typeof v === 'number') t[k] = (t[k] ?? 0) + v;
      }
    }
    t.worlds = open;
    t.packsOpen = packs;
    return t;
  }
}
