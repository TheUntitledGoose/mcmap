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
 * Open every world under a root. `defaultSlug` picks what a request gets when it does not name one;
 * with more than one world and no default, this refuses to guess - a boot that quietly chose "the first
 * folder alphabetically" is how someone ends up browsing the wrong save.
 */
export function openWorldsRoot({ root, defaultSlug = '', cache = null, cacheMaxGb = 2,
  defaultEmbed = '', log = () => {} } = {}) {
  const found = discoverWorlds(root);
  const bundles = [];
  for (const w of found.worlds) {
    // The slug IS the cache identity's name (shared/world-tag.mjs): a folder called `darkrpg` keeps its
    // payloads in `cache/darkrpg.<seed hash>/...` on every box, and a different save dropped under the
    // same folder name gets a different directory.
    const b = openWorld({
      slug: w.slug, dir: w.dir, cache, cacheMaxGb, worldTag: w.slug,
      // The tag came from the folder this save was dropped into, not from a flag: the boot log has to say
      // that, or an operator reading "from --world-tag darkrpg" goes hunting for a line in the stack.
      worldTagFrom: 'the folder name in the --worlds root',
      // `|| dir/packs/assets` even when absent, so the "no asset pack" sentence names the place this
      // world's pack should be rather than a generic build/assets.
      paths: { ...w.packs, assets: w.packs.assets || path.join(w.dir, 'packs', 'assets'),
        world: w.world, defaultEmbed },
    });
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
  return { registry: new WorldRegistry({ bundles, defaultSlug: def, problems: found.problems }), found };
}

/** One world, named by slug, for the routes. */
export class WorldRegistry {
  constructor({ bundles = [], defaultSlug = '', problems = [] } = {}) {
    this.bySlug = new Map(bundles.map((b) => [b.slug, b]));
    this.order = bundles.map((b) => b.slug);
    this.defaultSlug = defaultSlug;
    this.problems = problems;
    // A single --world bundle has no slug of its own; it is still the world every request means.
    this.single = bundles.length === 1 && !bundles[0].slug;
  }

  get multi() { return !this.single; }
  slugs() { return [...this.order]; }
  get default() { return this.single ? this.only() : (this.bySlug.get(this.defaultSlug) ?? null); }
  only() { return [...this.bySlug.values()][0]; }

  /** The world a request means: `?world=<slug>`, or the default. Null means the caller answers 404. */
  resolve(slug) {
    const s = slug === null || slug === undefined ? '' : String(slug);
    // One save: `world=` is either nothing or that save. A stale slug left in a bookmark gets the same
    // honest refusal as in a multi-world process - it is a request for a world this box does not have.
    if (this.single) return (!s || s === this.only().slug) ? this.only() : null;
    return this.bySlug.get(s === '' ? this.defaultSlug : s) ?? null;
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
