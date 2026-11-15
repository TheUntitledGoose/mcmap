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
import { openWorld, findSave, findPacks, slugOk, worldLabel, levelSummary } from './world-bundle.mjs';
import { levelSeed } from './world-dims.mjs';
import { worldTagFor } from '../shared/world-tag.mjs';
import { tableTag } from './world-service.mjs';
import { buildStateIds } from './chunk-payload.mjs';

/**
 * What a world is called, and what its payloads are filed under, without opening it.
 *
 * A world parked by `--worlds-max` still has to be answered about in `/meta` (a dropdown with no name in
 * it is worse than no dropdown) and in the cache keep-lists: the pruner treats a non-empty keep-list as
 * the truth about which saves are live, so a save that is merely *closed* must still appear in it, or a
 * boot would delete the payloads it is waiting for. Both come from two small files: `level.dat` (label,
 * version, seed) and `atlas.json` (the state table's content hash). No region file is touched.
 */
export function worldIdentity(w) {
  const out = { label: w.labelOverride ?? '', version: '', worldTag: '', tableTag: '' };
  try {
    const lv = levelSummary(w.world);
    out.version = String(lv.version ?? '');
    if (!out.label) out.label = worldLabel(w.world, w.slug);
  } catch { /* a save that will not read is still a folder someone dropped in */ }
  try {
    // Same identity `openWorld` would compute for this world: in a --worlds root the slug is the tag's name
    // (openWorldFor passes `worldTag: w.slug`), so a parked save must report the directory it will use or
    // the cache keep-list would name nothing and the sweep would delete what this world is waiting for.
    out.worldTag = worldTagFor({ dir: path.resolve(w.world), seed: levelSeed(w.world), override: w.slug });
  } catch { /* no seed: the payload cache cannot name this world yet */ }
  try {
    const a = w.packs.assets && path.join(w.packs.assets, 'atlas.json');
    if (a && fs.existsSync(a)) {
      const states = JSON.parse(fs.readFileSync(a, 'utf8')).states ?? [];
      out.tableTag = String(tableTag(buildStateIds(states.map((s) => s.k))));
    }
  } catch { /* no atlas: nothing in the payload cache can belong to this world */ }
  return out;
}

/** A world that is listed but not open: named, cacheable, with zero files held. */
function parkedEntry(w) {
  return { slug: w.slug, dir: w.dir, world: w.world, packs: w.packs, notOpen: 1, problem: '',
    ...worldIdentity(w) };
}

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
      // The packs being there is worth saying: it is the signature of someone who mounted a share half
      // way through a copy, or shipped the baked packs and left the save at home. Opening a world starts
      // at its level.dat (the dimensions, the seed the cache identity is built from, the version), so a
      // folder of packs alone is not a world this box can serve - and it should say which half arrived.
      const have = Object.entries(packs).filter(([, v]) => v).map(([k]) => k);
      out.problems.push(`${e.name}: no save inside ${dir} `
        + '(wanted save/world/level.dat, world/level.dat, or level.dat)'
        + (have.length ? ` - the packs did arrive (${have.join(', ')}); put the save in ${path.join(dir, 'save')}`
          + ' to go with them' : ''));
      continue;
    }
    // A name the operator chose, next to the save: `<slug>/world.json` holding `{"label": "..."}`. The
    // folder name has to stay the slug (it is the cache identity and the link), so this is where a
    // dropdown gets something a person recognises instead.
    let labelOverride = '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
      labelOverride = String(j.label ?? '').trim().slice(0, 80);
    } catch { /* no world.json, or one that will not parse: the folder name labels it */ }
    out.worlds.push({ slug: e.name, dir, world: save.world, packs, labelOverride,
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
    slug: w.slug, dir: w.dir, cache, cacheMaxGb, worldTag: w.slug, labelOverride: w.labelOverride,
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
 * Open worlds under a root, up to `maxOpen` of them (0 = no cap). `defaultSlug` picks what a request
 * gets when it does not name one; with more than one world and no default, this refuses to guess - a boot
 * that quietly chose "the first folder alphabetically" is how someone ends up browsing the wrong save.
 *
 * The cap is what keeps a box with a dozen saves in its worlds root from paying for all of them at boot.
 * Every open world parses its atlas, decodes its spawn chunk, and holds its own region-file LRU (48 files)
 * plus decoded-chunk, pack and LOD caches - and a link names one save, so the rest are only listed:
 * named in `/meta`, in the dropdown, and in the cache keep-lists, and opened the first time a request
 * names them. Their payloads are already on disk under their own cache tag, so opening one late is reads,
 * not decodes.
 */
export function openWorldsRoot({ root, defaultSlug = '', cache = null, cacheMaxGb = 2,
  defaultEmbed = '', refreshTtlMs = 15000, maxOpen = 4, log = () => {} } = {}) {
  const found = discoverWorlds(root);
  const openOpts = { cache, cacheMaxGb, defaultEmbed, log };
  const discovered = new Map(found.worlds.map((w) => [w.slug, w]));
  let def = defaultSlug;
  if (!def && found.worlds.length === 1) def = found.worlds[0].slug;
  if (def && !discovered.has(def)) {
    found.problems.push(`--world-default ${def}: no such world (have: ${found.worlds.map((w) => w.slug).join(', ') || 'none'})`);
    def = '';
  }
  // The default first, then the rest in folder name order: with a cap on how many worlds stand open, the
  // one a request gets when it names nothing is the last thing that should end up parked.
  const ranked = [...found.worlds].sort((a, b) =>
    ((a.slug === def ? 0 : 1) - (b.slug === def ? 0 : 1)) || a.slug.localeCompare(b.slug));
  const bundles = [];
  let open = 0;
  for (const w of ranked) {
    // The slug IS the cache identity's name (shared/world-tag.mjs): a folder called `darkrpg` keeps its
    // payloads in `cache/darkrpg.<seed hash>/...` on every box, and a different save dropped under the
    // same folder name gets a different directory.
    if (maxOpen > 0 && open >= maxOpen) { bundles.push(parkedEntry(w)); continue; }
    const b = openWorldFor(w, openOpts);
    bundles.push(b);
    if (b.problem) found.problems.push(`${w.slug}: ${b.problem.split('\n')[0]}`);
    else open++;
  }
  const good = bundles.filter((b) => !b.problem && !b.notOpen);
  if (def && !bundles.some((b) => b.slug === def && !b.notOpen)) def = '';
  if (!def && good.length > 1) {
    found.problems.push(`more than one world and no --world-default (have: ${good.map((b) => b.slug).join(', ')})`);
  }
  const registry = new WorldRegistry({ bundles, defaultSlug: def, problems: found.problems,
    root, openOpts, refreshTtlMs, maxOpen, discovered, log });
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
    refreshTtlMs = 15000, maxOpen = 0, discovered = null, log = () => {} } = {}) {
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
    // `--worlds-max`: how many worlds may stand open at once. The rest are listed and opened on demand,
    // and this is the bookkeeping that makes that possible - none of it holds a file.
    this.maxOpen = Math.max(0, maxOpen | 0);
    this.discovered = discovered || new Map();  // slug -> what the last scan of the root saw
    this.lastUsed = new Map();                 // slug -> ms of the last request that named it: the LRU clock
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
      this.discovered.set(w.slug, w);
      const cur = this.bySlug.get(w.slug);
      // A parked world has no problem and is not open; it is re-described below rather than opened here,
      // so packs arriving for it show up in /meta without the cap being spent on it.
      if (cur && !cur.problem && !cur.notOpen) continue;
      if (cur && !cur.notOpen && now < (this.nextTry.get(w.slug) ?? 0)) continue;
      const b = this.openOrPark(w);
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
      if (!seen.has(slug)) { this.missing.add(slug); this.discovered.delete(slug); }
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
    const key = s === '' ? this.defaultSlug : s;
    let hit = this.bySlug.get(key) ?? null;
    if (hit?.notOpen) hit = this.openNow(key) ?? hit;
    if (hit) this.lastUsed.set(key, Date.now());
    if (hit || !s || !this.root) return hit;
    // A named slug this process has never seen: look at the root once before refusing, because the most
    // likely reason is that the save was dropped in since the last boot. Guarded by its own clock rather
    // than the TTL clock, so a boot-time scan does not blind the registry to a link typed a minute later,
    // and a stray `?world=` typo cannot turn into a readdir per request.
    const now = Date.now();
    // The miss guard is the configured glance interval, never longer: a box that asked for a faster
    // glance (`--worlds-scan 0`, say) means it, and a box on the default still cannot be made to walk the
    // root once per bogus `?world=`.
    const floor = Math.min(MISS_FLOOR_MS, this.refreshTtlMs);
    if (now - (this.lastMissScan ?? 0) < floor) return null;
    this.lastMissScan = now;
    this.refresh({ now, floor: 0 });
    const fresh = this.bySlug.get(s) ?? null;
    if (fresh?.notOpen) return this.openNow(s) ?? fresh;
    if (fresh) this.lastUsed.set(s, Date.now());
    return fresh;
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

  /** How many worlds are standing open right now. */
  countOpen() {
    let n = 0;
    for (const b of this.bySlug.values()) if (!b.problem && !b.notOpen) n++;
    return n;
  }

  /** Slugs standing open right now, in the order the root listed them. */
  openSlugs() {
    return [...this.bySlug.values()].filter((b) => !b.problem && !b.notOpen).map((b) => b.slug);
  }

  /** Is the world a request gets when it names nothing currently open? */
  defaultOpen() { return !!this.bySlug.get(this.defaultSlug) && !this.bySlug.get(this.defaultSlug).notOpen; }

  /** Open a world now, or list it without opening it if the cap is already spent. */
  openOrPark(w) {
    if (this.maxOpen && this.countOpen() >= this.maxOpen) return parkedEntry(w);
    return openWorldFor(w, this.openOpts);
  }

  /**
   * Open a world the last scan saw but the cap kept closed. This is what a link to a parked save costs:
   * two small file reads and an atlas parse, then payloads out of the cache it already has.
   */
  openNow(slug) {
    const w = this.discovered.get(slug);
    if (!w) return null;
    const b = openWorldFor(w, this.openOpts);
    this.bySlug.set(slug, b);
    if (!this.order.includes(slug)) this.order.push(slug);
    this.lastUsed.set(slug, Date.now());
    if (b.problem) {
      this.nextTry.set(slug, Date.now() + FAILED_RETRY_MS);
      this.problems = [...this.problems.filter((p) => !p.startsWith(`${slug}:`)), `${slug}: ${b.problem.split('\n')[0]}`];
      this.log(`world ${slug} refused: ${b.problem.split('\n')[0]}`);
      return b;
    }
    this.nextTry.delete(slug);
    this.problems = this.problems.filter((p) => !p.startsWith(`${slug}:`));
    this.log(`world ${slug} opened on request: v${b.level().version}, table ${b.tableTag}, dims ${b.svc.dims.size}`);
    this.parkOverCap(slug);
    return b;
  }

  /**
   * Let go of everything a world is holding - open region files, decoded chunk and shell frames, baked
   * pack buffers, LOD tiles - and keep its name. Its payloads stay on disk under its own cache tag, so
   * parking costs nothing a later request does not simply read back.
   */
  park(slug) {
    const b = this.bySlug.get(slug);
    if (!b || b.notOpen || !b.svc) return;
    const tag = b.svc.worldTag;
    b.svc.close();
    b.notOpen = 1;
    this.log(`world ${slug} parked: it holds no files now; its payloads stay under ${tag}`);
  }

  /**
   * Close the longest-idle worlds until no more than `maxOpen` stand open, the one just used excepted.
   *
   * The default world is never the one closed if it can be avoided: a request that names nothing gets
   * that save, and the dropdown offers it, so the cap bends by one rather than the page breaking.
   */
  parkOverCap(keep = '') {
    if (!this.maxOpen) return;
    const idle = [...this.bySlug.values()]
      .filter((b) => !b.problem && !b.notOpen && b.slug !== keep)
      .sort((a, b) => (this.lastUsed.get(a.slug) ?? 0) - (this.lastUsed.get(b.slug) ?? 0));
    for (const b of idle) {
      if (this.countOpen() <= this.maxOpen) break;
      if (b.slug === this.defaultSlug && this.countOpen() === this.maxOpen + 1) continue;
      this.park(b.slug);
    }
  }

  /**
   * What a parked world reports in `/meta`. It has no service to ask, so this comes from the two small
   * files `worldIdentity` reads: a dropdown with a blank entry in it is worse than no dropdown.
   */
  parkedFacts(b) {
    return {
      slug: b.slug, label: b.label, worldTag: b.worldTag, tableTag: b.tableTag, world: b.world,
      level: { name: b.label, version: b.version }, dims: [], open: 0, parked: 1,
      packed: {
        shells: !!b.packs?.shells, lod: null, ledger: false,
        assets: !!b.packs?.assets, skins: !!b.packs?.skins,
      },
    };
  }

  /** Every world this registry will answer about, open or parked. The cache sweep's keep-list source: a
   *  parked world is still a save on this box, and the sweep treats a non-empty keep-list as the truth.
   */
  live() { return [...this.bySlug.values()].filter((b) => (!b.problem && b.svc) || b.notOpen); }

  /** Cache identity tags of every world this box serves, open or parked. */
  cacheKeep() { return this.live().map((b) => b.svc?.worldTag || b.worldTag).filter(Boolean); }

  /** State table tags of every world this box serves, open or parked. */
  cacheKeepTables() { return this.live().map((b) => b.svc?.tableTag || b.tableTag).filter(Boolean); }

  /**
   * [save tag, its state-table tags] for every world this process answers about, open or closed. The
   * pruner needs the PAIRING: two separate keep-lists cannot tell "another save's cache" apart from "this
   * save's cache under a name it changed" - and the second is 11 GB of saved CPU that a sweep would throw
   * away, leaving the viewer slow and the log silent.
   */
  cacheTableOwners() {
    return this.live()
      .map((b) => [String(b.svc?.worldTag || b.worldTag || ''),
        [String(b.svc?.tableTag || b.tableTag || '')].filter(Boolean)])
      .filter(([w, tabs]) => w && tabs.length);
  }

  /**
   * A per-world row for `/stats`: what each save costs while it is open, nothing where it is parked.
   * Otherwise "why is this process 600 MB" has no answer on a box that lists twelve saves and holds four.
   */
  perWorld() {
    return [...this.bySlug.values()].map((b) => {
      const st = !b.problem && !b.notOpen ? b.svc.stats : null;
      return {
        slug: b.slug, label: b.label ?? '', open: st ? 1 : 0, parked: b.notOpen ? 1 : 0,
        problem: (b.problem || '').split('\n')[0],
        worldTag: b.svc?.worldTag || b.worldTag || '', tableTag: b.svc?.tableTag || b.tableTag || '',
        version: b.version ?? '', lastUsed: this.lastUsed.get(b.slug) ?? 0,
        dims: st ? b.svc.dims.size : 0,
        // What holding this save open costs, in files and bytes: the answer to "why is this process big".
        regionOpen: st ? b.svc.order.length : 0,      // region files with a handle on them
        regionKnown: st ? b.svc.regions.size : 0,     // ...plus ones remembered as absent
        packsOpen: st ? b.svc.packs.size : 0,         // baked shell packs (~1 MB inflated each)
        shellsCached: st ? b.svc.shells.size : 0,     // decoded far-view frames
        lodsCached: st ? b.svc.lods.size : 0,         // overview LOD tiles
        cacheBytes: st?.cacheBytes ?? 0, cacheHits: st?.cacheHits ?? 0, decodes: st?.decodes ?? 0,
      };
    });
  }

  list() {
    return [...this.bySlug.values()].map((b) => (b.problem
      ? { slug: b.slug, label: b.slug, problem: b.problem.split('\n')[0], open: 0 }
      : b.notOpen ? this.parkedFacts(b) : { ...b.facts(), open: 1 }));
  }

  /** Stats summed across worlds, for the heartbeat line (one process, several saves). */
  totals() {
    const t = {};
    let packs = 0, open = 0, parked = 0;
    for (const b of this.bySlug.values()) {
      if (b.problem) continue;
      if (b.notOpen) { parked++; continue; }
      open++;
      packs += b.svc.packs.size;
      for (const [k, v] of Object.entries(b.svc.stats)) {
        if (typeof v === 'number') t[k] = (t[k] ?? 0) + v;
      }
    }
    t.worlds = open + parked;
    t.open = open;
    t.parked = parked;
    t.packsOpen = packs;
    return t;
  }
}
