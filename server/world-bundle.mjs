/**
 * One world, opened: the save, the asset pack it was baked against, the far packs, the block history,
 * the skins and the card.
 *
 * Before M18 a `worldd` process *was* a world: `const svc = ...` at module scope, every route reading
 * that one object. One box serving several saves needs one of these per save, and a route that has to
 * say which save it means. `server/world-registry.mjs` decides which worlds exist; this file opens one.
 *
 * Two rules the shape follows:
 *
 * - **A world's asset pack is part of its identity, not a shared default.** Chunk payloads carry *state
 *   ids*, and those ids are the order `atlas.json` lists its states in. Render save B against save A's
 *   atlas and B's voxels get labelled with A's blocks - the same class of wrong answer the payload
 *   cache's world level exists to prevent, one layer up. So a world with no asset pack of its own is
 *   reported, not quietly borrowed: it answers nothing but the reason.
 * - **A world that will not open must not take the process down with it.** A registry with three worlds
 *   and one broken pack should serve two. (When the operator named one world with `--world`, `worldd`
 *   still exits with the bake sentence - there is nothing else on that box to serve.)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { WorldService } from './world-service.mjs';
import { atlasStamp } from './shell-pack.mjs';
import { buildStateIds } from './chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { summarizeLodDir } from './lod-pack.mjs';
import { LedgerService } from './ledger-service.mjs';
import { skinStripFor } from './skin-strip.mjs';

/**
 * A world slug: one path segment, nothing else. It comes from a directory name in `--worlds`, it goes
 * into `?world=` from a browser, and it names the payload-cache directory, so `?world=../../etc` must be
 * a lookup miss rather than a path.
 */
export const SLUG_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export function slugOk(s) { return SLUG_OK.test(String(s ?? '')); }

/**
 * Where the save is inside a world directory. Three shapes are accepted, because the second is the
 * layout one push installs (and the one the README documents) and the third is what someone drops in
 * when they just copy a world folder:
 *
 *   <dir>/save/world/level.dat      (the layout the plan and the push tool use)
 *   <dir>/world/level.dat           (a bare save folder named by its slug)
 *   <dir>/level.dat                 (the slug folder *is* the world folder)
 *
 * The order matters: `save` first, so a folder that happens to hold both is read as the deliberate one.
 */
export function findSave(dir) {
  const cand = [path.join(dir, 'save'), dir];
  for (const c of cand) {
    if (fs.existsSync(path.join(c, 'world', 'level.dat'))) return { world: path.join(c, 'world'), root: c };
  }
  if (fs.existsSync(path.join(dir, 'level.dat'))) return { world: dir, root: dir };
  return { world: null, root: null };
}

/** The pack directories of a world bundle: `<dir>/packs/<pack>`, the layout one push installs. */
export function findPacks(dir, pack) {
  const p = path.join(dir, 'packs', pack);
  return fs.existsSync(p) ? p : null;
}

/** What the card's picture is for this world, in the order the deployment can override it. */
export function embedImageFor(paths, override) {
  const cand = [
    override,
    paths.embed ? path.join(paths.embed, 'embed.png') : '',
    paths.assets ? path.join(paths.assets, 'embed.png') : '',
    'build/embed.png',
    paths.defaultEmbed || '',
  ].filter(Boolean);
  for (const f of cand) if (fs.existsSync(f)) return f;
  return null;
}

/**
 * level.dat, read once per world and memoised. Note `Version.Id`: that is the protocol number (3465 for
 * 1.20.1), not a version a person would say out loud, so `/meta` reports it as `protocol` and takes the
 * human string from `Version.Name`.
 */
export function levelSummary(worldDir) {
  try {
    const dat = zlib.gunzipSync(fs.readFileSync(path.join(worldDir, 'level.dat')));
    const d = readNbt(dat).value.Data;
    return {
      name: String(d.LevelName ?? ''),
      version: String(d.Version?.Name ?? d.version?.Name ?? ''),
      protocol: Number(d.Version?.Id ?? 0),
      dataVersion: Number(d.DataVersion ?? 0),
      spawn: [Number(d.SpawnX ?? 0), Number(d.SpawnY ?? 0), Number(d.SpawnZ ?? 0)],
      gameType: Number(d.GameType ?? -1), hardcore: Number(d.hardcore ?? 0), difficulty: String(d.difficulty ?? ''),
    };
  } catch (e) { return { error: String(e.message ?? e) }; }
}

/**
 * What to call a world. `LevelName` is "world" in most saves, which names nothing, so a generic level
 * name falls back to the directory that holds the save: `/data/DarkRPG/world` is "DarkRPG", and in the
 * `--worlds` layout the slug already is the name an operator chose.
 */
export function worldLabel(worldDir, slug = '', override = '') {
  // A name written next to the save (`<slug>/world.json`, `{"label": "..."}`) wins: the folder name is the
  // slug, the cache identity and the link, and an operator should not have to rename a directory to give
  // a map a readable title.
  const o = String(override ?? '').trim();
  if (o) return o;
  const lv = levelSummary(worldDir);
  const generic = /^(world|world_nether|world_the_end|new world|)?$/i.test(lv.name ?? '');
  if (!generic && lv.name) return lv.name;
  if (slug) return slug;
  const parent = path.basename(path.resolve(worldDir));
  const up = path.basename(path.dirname(path.resolve(worldDir)));
  return /^(world|save|packs)$/i.test(parent) ? up : parent;
}

/**
 * The slug a save in the `--worlds` layout goes by: `<root>/<slug>/save/world`, or the bare
 * `<root>/<slug>/world`. The registry passes that slug as the cache identity's *name*, so anything else
 * that decodes the same save has to agree with it or its payloads land where no server will read them.
 *
 * Measured, not hypothetical: baking the `prominence` save in that layout filed 30 038 chunks under
 * `save-world.00504d09/`, because the last two segments of every worlds-root save are `save/world` - so
 * the name says nothing about which save, and two saves copied from one seed would share the directory
 * outright. An empty answer means "this is not a worlds-root path", and the caller falls back to naming
 * the cache by directory and seed, which is what it always did.
 */
export function worldSlugFor(worldDir) {
  const dir = path.resolve(worldDir);
  const here = path.basename(dir);
  const up1 = path.basename(path.dirname(dir));
  const up2 = path.basename(path.dirname(path.dirname(dir)));
  if (here !== 'world') return '';
  if (up1 === 'save' && slugOk(up2)) return up2;
  if (slugOk(up1)) return up1;
  return '';
}

/**
 * Open one world. `paths` are absolute-ish directories: `world` (the save's world folder), `assets`,
 * `shells` (the shell/overview packs), `lods`, `ledger`, `skins`, `embed`; `none` or null means "off".
 *
 * Returns `{ slug, label, paths, svc, ledger, ... }` or, when the world cannot be rendered,
 * `{ slug, problem }` - a sentence that names the pack and the verb that would have made it exist.
 */
export function openWorld({ slug = '', dir = '', paths, cache = null, cacheMaxGb = 2,
  worldTag = '', worldTagFrom = '', labelOverride = '', coverageTtlMs, log = () => {} } = {}) {
  const off = (v) => (v === 'none' || !v ? null : v);
  const P = {
    world: paths.world,
    assets: off(paths.assets),
    shells: off(paths.shells),
    lods: off(paths.lods),
    ledger: off(paths.ledger),
    skins: off(paths.skins),
    embed: off(paths.embed),
    defaultEmbed: paths.defaultEmbed,
  };
  const b = { slug, dir, paths: P, problem: '' };

  // Asset pack first: it is the one pack whose absence stops this world from answering anything, and in a
  // container this sentence is the whole user-visible answer between restarts. Name the bake command and
  // the variable a mount would set - a bare path in a log is how a deploy that "succeeded" ends up
  // looking like a broken map.
  const atlasPath = path.join(P.assets ?? 'build/assets', 'atlas.json');
  if (!P.assets || !fs.existsSync(atlasPath)) {
    const A = P.assets ?? 'build/assets';
    b.problem = `no ${atlasPath}\n  bake it:   node server/pack-assets.mjs build/census.json ${A}\n`
      + `             (needs the save and your own 1.20.1 client jar on this machine)\n`
      + (slug
        ? `  or drop a baked asset pack at  ${A}  (the packs folder of world '${slug}')`
        : `  or mount a baked pack and point the server at it:  --assets <dir>   /   WD_ASSETS=<dir>`);
    return b;
  }
  if (!P.world || !fs.existsSync(P.world)) {
    b.problem = `no save at ${paths.world}`
      + (slug ? ` (a world folder wants save/world/level.dat, world/level.dat, or level.dat inside ${dir})`
        : '  (--world <dir>   /   WD_WORLD=<dir>)');
    return b;
  }

  const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
  const stateIds = buildStateIds(atlas.states.map((s) => s.k));
  const stateCls = classifyStates(atlas.states, atlas.textures);
  const stamp = atlasStamp(fs.statSync(atlasPath), atlas.states.length);
  b.atlas = atlas;
  b.stamp = stamp;

  b.svc = new WorldService(P.world, stateIds, cache ? cache : null, {
    isCubeState: (id) => stateCls.cube[id - 1] === 1,
    // A far column needs two different answers: which block may *paint* it, and which one can hold a
    // surface up. Water holds a lake skin up but must not paint it blue; a rose holds nothing up.
    isPaintState: (id) => stateCls.cube[id - 1] === 1 && stateCls.opaque[id - 1] === 1,
    isSolidState: (id) => stateCls.cube[id - 1] === 1,
    isFilmState: (id) => stateCls.film[id - 1] === 1,
    packDir: P.shells,
    lodDir: P.lods,
    stamp,
    worldTag,
    ...(worldTagFrom ? { worldTagFrom } : {}),
    cacheMaxGb,
    ...(coverageTtlMs ? { coverageTtlMs } : {}),
  });
  b.tableTag = String(b.svc.tableTag);
  b.worldTag = b.svc.worldTag;
  b.lodSummary = P.lods ? summarizeLodDir(P.lods) : { dims: 0, tiles: 0, cells: [] };
  b.ledger = new LedgerService(P.ledger ?? 'none');
  b.levelCache = null;
  b.level = () => (b.levelCache ??= levelSummary(P.world));
  b.label = worldLabel(P.world, slug, labelOverride);

  // The skin pack, read once and re-read only when the manifest moves: a pack that changed under a
  // running server (someone ran tools/fetch-skins.mjs) has to be picked up without a restart.
  let skinCache = null;
  b.skins = () => {
    if (!P.skins) return null;
    const r = skinStripFor(P.skins);
    if (!r.pack) return null;
    if (!skinCache || skinCache.mtime !== r.mtime) skinCache = r;
    return skinCache;
  };
  b.skinSummary = () => {
    const s = b.skins();
    if (!s) {
      return { available: false, why: !P.skins ? 'skins disabled'
        : `no pack under ${paths.skins}: run tools/fetch-skins.mjs` };
    }
    return { available: true, generated: s.pack.generated, players: s.pack.list.length,
      without: s.pack.missing.map((m) => m.name) };
  };

  /** Facts a card and a dropdown are built from, without opening anything else. */
  b.facts = () => ({
    slug: b.slug,
    label: b.label,
    worldTag: b.worldTag,
    tableTag: b.tableTag,
    world: b.paths.world,
    level: { name: b.level().name, version: b.level().version },
    dims: b.svc.dimList().map((d) => ({ id: d.id, regions: d.regions })),
    packed: {
      shells: !!b.paths.shells && fs.existsSync(b.paths.shells),
      lod: b.lodSummary,
      ledger: b.ledger.ready,
      assets: true,
      skins: b.skinSummary().available,
    },
  });
  log(`opened ${slug || paths.world}`);
  return b;
}

/** Counts of what is on disk for a world, for the boot log ("the directory exists" is not "the pack is"). */
export function packHere(dir) {
  if (!dir || dir === 'none' || !fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f !== '.keep' && !f.startsWith('.')).length;
}
