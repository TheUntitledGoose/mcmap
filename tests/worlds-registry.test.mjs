// The worlds registry (server/world-registry.mjs + server/world-bundle.mjs): which saves a process
// serves, what a request that names one gets, and what a request that names a non-existent one gets.
//
// This runs on any machine: the worlds here are synthetic - a level.dat that is not even NBT, and an
// atlas.json with two states. That is enough to open a world (the atlas is what decides the state table,
// the save folder is what decides the cache identity), and everything this file is about is routing and
// identity, not world content. The real-save half of the contract is tests/http-worlds.data.mjs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverWorlds, openWorldsRoot, WorldRegistry } from '../server/world-registry.mjs';
import { slugOk, findSave, openWorld } from '../server/world-bundle.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worlds-'));
const at = (...p) => path.join(tmp, ...p);

// An atlas the bundle can open: two states, no geometry. The state table (and so `tableTag`) comes out
// of it, which is the whole point - two worlds with the same atlas get the same table tag.
const FAKE_ATLAS = JSON.stringify({
  states: [{ k: 'minecraft:air', r: 3 }, { k: 'minecraft:stone' }],
  textures: [], atlasSize: [16, 16], geometry: { bytes: 0, verts: 0 },
});

function touch(p, body = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

/**
 * A world folder in one of the accepted shapes. `packs` names which packs to create; a level.dat full of
 * junk is deliberate - the registry only asks whether it exists, and a world whose level.dat cannot be
 * read still has to be listed (its label falls back to the slug rather than the boot dying).
 */
function mkWorldAt(root, slug, { shape = 'save', packs = ['assets', 'shells', 'lods', 'ledger', 'skins'], regions = 1 } = {}) {
  const dir = path.join(root, slug);
  const world = shape === 'save' ? path.join(dir, 'save', 'world')
    : shape === 'direct' ? dir : path.join(dir, 'world');
  touch(path.join(world, 'level.dat'), 'not really NBT');
  for (let i = 0; i < regions; i++) touch(path.join(world, 'region', `r.${i}.0.mca`), '\0'.repeat(8));
  for (const p of packs) {
    if (p === 'assets') touch(path.join(dir, 'packs', 'assets', 'atlas.json'), FAKE_ATLAS);
    else touch(path.join(dir, 'packs', p, '.keep'), '');
  }
  return dir;
}
const mkWorld = (slug, o) => mkWorldAt(tmp, slug, o);

// ---------------------------------------------------------------- discovery

test('a worlds root is a folder of slugs, and the shape of each save inside it is not fixed', () => {
  const root = at('shapes');
  mkWorldAt(root, 'a', { shape: 'save' });            // <slug>/save/world/level.dat     (the documented layout)
  mkWorldAt(root, 'b', { shape: 'world' });           // <slug>/world/level.dat          (a bare save folder)
  mkWorldAt(root, 'c', { shape: 'direct' });          // <slug>/level.dat                (the folder IS the world)
  const found = discoverWorlds(root);
  assert.deepEqual(found.worlds.map((w) => w.slug), ['a', 'b', 'c'], 'sorted by slug, and all three shapes read');
  assert.ok(found.worlds[0].world.endsWith(path.join('save', 'world')), 'the `save` shape wins over a bare world');
  assert.deepEqual(found.worlds[0].packsHere, ['assets', 'shells', 'lods', 'ledger', 'skins'],
    'the pack names in the listing are the names on disk');
  assert.ok(found.worlds.every((w) => w.world.startsWith(root)), 'a save stays inside the root');
});

test('junk in a worlds root is reported, not opened', () => {
  const root = at('junk-root');
  fs.mkdirSync(path.join(root, '.hidden', 'world'), { recursive: true });
  touch(path.join(root, '.hidden', 'world', 'level.dat'));
  touch(path.join(root, 'stray.txt'), 'not a world');   // a FILE named stray.txt is not a world
  fs.mkdirSync(path.join(root, 'Not A Slug'), { recursive: true });
  touch(path.join(root, 'empty-dir', 'readme.md'));   // a folder with no save in it
  const found = discoverWorlds(root);
  assert.deepEqual(found.worlds, [], 'nothing here is a world');
  assert.ok(found.problems.some((p) => /Not A Slug/.test(p)), 'a bad slug is named');
  assert.ok(found.problems.some((p) => /empty-dir.*no save inside/.test(p)), 'a folder without a save is named');
  assert.ok(!found.problems.some((p) => /hidden/.test(p)), 'a dot-folder is not a world, and not a complaint');
  assert.ok(!slugOk('../../etc') && !slugOk('a/b') && !slugOk('') && slugOk('darkrpg') && slugOk('a.b-c_1'));
});

test('findSave answers where the save is, or nothing, and never guesses outside the folder', () => {
  const d = at('shapeshape');
  fs.mkdirSync(path.join(d, 'whatever'), { recursive: true });
  assert.equal(findSave(d).world, null, 'no level.dat anywhere is no save');
  touch(path.join(d, 'world', 'level.dat'));
  assert.equal(findSave(d).world, path.join(d, 'world'));
});

// ---------------------------------------------------------------- opening, and the identity that comes with it

test('two worlds with the same atlas share a state table and must not share one payload cache', () => {
  const root = at('two');
  mkWorldAt(root, 'one'); mkWorldAt(root, 'two');
  const { registry } = openWorldsRoot({ root, defaultSlug: 'one', cache: at('cache-two') });
  const a = registry.resolve('one'), b = registry.resolve('two');
  assert.ok(a && !a.problem && b && !b.problem, 'both opened');
  assert.equal(a.tableTag, b.tableTag, 'same atlas, so the state-table tag says they match');
  assert.notEqual(a.worldTag, b.worldTag, 'the slug is what tells them apart');
  assert.ok(a.worldTag.startsWith('one.'), `a slug-named tag should still read as the slug, got ${a.worldTag}`);
  // The boot log explains where a cache directory name came from. For a --worlds folder that answer is
  // "the folder it was dropped in": saying `--world-tag one` would send an operator hunting for a flag
  // that nobody typed.
  assert.match(a.svc.worldTagFrom, /folder name in the --worlds root/, 'and the log says where the tag came from');
  assert.notEqual(a.svc.cachePath('minecraft:overworld', 5, 7), b.svc.cachePath('minecraft:overworld', 5, 7),
    'chunk 5,7 decoded for one world must not be readable as the other world\'s answer');
});

test('the default world is named, guessed only when there is exactly one, and never picked alphabetically', () => {
  const one = at('only-one');
  mkWorldAt(one, 'solo');
  const r1 = openWorldsRoot({ root: one, cache: at('cache-solo') });
  assert.equal(r1.registry.defaultSlug, 'solo', 'one world is the default without being told');

  const two = at('two-defaults');
  mkWorldAt(two, 'alpha'); mkWorldAt(two, 'zulu');
  const r2 = openWorldsRoot({ root: two, cache: at('cache-two-d') });
  assert.equal(r2.registry.defaultSlug, '', 'two worlds and no --world-default is a question, not a coin flip');
  assert.ok(r2.found.problems.some((p) => /no --world-default/.test(p)), 'and the boot says which worlds it meant');
  assert.equal(r2.registry.resolve(null), null, 'so a request that names nothing is refused, not guessed');
  const r3 = openWorldsRoot({ root: two, defaultSlug: 'zulu', cache: at('cache-two-d') });
  assert.equal(r3.registry.resolve(null).slug, 'zulu');
  const r4 = openWorldsRoot({ root: two, defaultSlug: 'nope', cache: at('cache-two-d') });
  assert.equal(r4.registry.defaultSlug, '', 'a --world-default that is not a world is a problem, not a fallback');
  assert.ok(r4.found.problems.some((p) => /no such world/.test(p)));
});

test('an unknown slug is refused by name; the answer lists what does exist', () => {
  const root = at('refusal');
  mkWorldAt(root, 'darkrpg'); mkWorldAt(root, 'skyblock');
  const { registry } = openWorldsRoot({ root, defaultSlug: 'darkrpg', cache: at('cache-refuse') });
  assert.equal(registry.resolve('skyblock').slug, 'skyblock');
  assert.equal(registry.resolve('nope'), null);
  const why = registry.whyMiss('nope');
  assert.match(why, /unknown world 'nope'/);
  assert.match(why, /darkrpg, skyblock/, 'the answer has to name the worlds, or the typo is undebuggable');
  assert.match(why, /Omit world=/, 'and say what an unqualified request means');
  for (const s of ['../etc', 'a/b', 'Dark RPG']) assert.equal(registry.resolve(s), null, `${s} is not a world`);
});

test('a world whose packs never arrived is listed with its reason, and does not take the box down', () => {
  const root = at('broken');
  mkWorldAt(root, 'ready');
  mkWorldAt(root, 'nopacks', { packs: [] });   // save, but no packs/assets at all
  const { registry } = openWorldsRoot({ root, defaultSlug: 'ready', cache: at('cache-broken') });
  const bad = registry.resolve('nopacks');
  assert.ok(bad.problem, 'the world is known to be broken');
  assert.match(bad.problem, /packs\/assets|packs\\assets/, 'and the reason names where its atlas should be');
  assert.match(bad.problem, /pack-assets\.mjs/, 'with the verb that would have made it exist');
  const listed = registry.list();
  assert.equal(listed.length, 2, 'a broken world is listed, not hidden');
  assert.ok(listed.find((w) => w.slug === 'nopacks').problem, 'the listing carries the problem');
  assert.ok(!registry.resolve('ready').problem, 'the other world still opened');
});

test('a level.dat that cannot be read still gets a world, named by its slug', () => {
  const root = at('unreadable');
  mkWorldAt(root, 'rough');
  const { registry } = openWorldsRoot({ root, cache: at('cache-rough') });
  const b = registry.resolve('rough');
  assert.ok(!b.problem, 'a junk level.dat is not a reason to refuse the save');
  assert.equal(b.label, 'rough', 'the label falls back to the slug the operator chose');
  assert.ok(b.level().error, 'and /meta says the level.dat did not read, rather than inventing a version');
});

test('the heartbeat bills every world, not just the one that came up first', () => {
  const root = at('totals');
  mkWorldAt(root, 'x'); mkWorldAt(root, 'y');
  const { registry } = openWorldsRoot({ root, defaultSlug: 'x', cache: at('cache-totals') });
  const t = registry.totals();
  assert.equal(t.worlds, 2);
  assert.equal(typeof t.decodes, 'number', 'the stats the heartbeat diffs are summed across worlds');
});

test('one --world save stays exactly the shape it always was', () => {
  const root = at('legacy');
  const dir = mkWorld('legacy', { shape: 'direct' });
  const b = openWorld({
    slug: '', dir,
    paths: { world: dir, assets: path.join(dir, 'packs', 'assets'), shells: null, lods: null,
      ledger: null, skins: null, embed: null },
    cache: null,
  });
  assert.ok(!b.problem, 'opened');
  assert.equal(b.svc.worldTagFrom, 'the world directory and its seed',
    'a single save still explains its tag the old way');
  const reg = new WorldRegistry({ bundles: [b], defaultSlug: '' });
  assert.equal(reg.multi, false, 'a single unnamed world is not a multi-world box');
  assert.equal(reg.resolve(null).slug, '', 'a request with no world= gets it');
  assert.equal(reg.resolve('anything'), null, 'and a request naming a world it does not have is refused');
  assert.match(reg.whyMiss('anything'), /serves one save/, 'with the reason, and how to get more worlds');
});

// ------------------------------------------------------- a root that changes while running

test('a save dropped into the worlds root while the box runs is served without a restart', () => {
  const root = at('grow');
  mkWorldAt(root, 'first');
  const { registry: reg } = openWorldsRoot({ root, defaultSlug: 'first', cache: at('cache-grow') });
  assert.deepEqual(reg.slugs(), ['first'], 'one world at boot');
  mkWorldAt(root, 'second');
  // The TTL path declines when asked twice in a row, so `/meta` polling cannot turn into a disk scan.
  assert.equal(reg.refresh({ floor: 600000 }), null, 'a refresh that is not due declines, and says so');
  // A request naming the new save is its own trigger: the copy finished a minute ago and the link is now.
  const b = reg.resolve('second');
  assert.ok(b && !b.problem, 'the miss itself re-looked at the root');
  assert.deepEqual(reg.slugs(), ['first', 'second'], 'and the new slug is a world now');
  assert.notEqual(b.worldTag, reg.resolve('first').worldTag, 'with its own cache identity');
  const later = reg.refresh({ now: Date.now() + 600000 });
  assert.ok(later && later.added.length === 0, 'a later glance finds nothing new to add');
});

test('a slug that is not here does not buy a disk scan per request', () => {
  const root = at('typo');
  mkWorldAt(root, 'only');
  const { registry: reg } = openWorldsRoot({ root, defaultSlug: 'only', cache: at('cache-typo') });
  assert.equal(reg.resolve('nope'), null, 'refused');
  mkWorldAt(root, 'arrived');                        // dropped in during the miss-guard's window
  assert.equal(reg.resolve('arrived'), null, 'the guard means this one does not look again');
  assert.ok(reg.resolve('nope') === null, 'still refusing, not guessing');
});

test('a world whose packs arrived late stops being a problem, but not on every glance', () => {
  const root = at('late');
  mkWorldAt(root, 'slow', { packs: [] });            // a save with no asset pack: listed, not openable
  const { registry: reg } = openWorldsRoot({ root, defaultSlug: 'slow', cache: at('cache-late') });
  const bad = reg.resolve('slow');
  assert.ok(bad && bad.problem, 'at boot it is a world with a reason, not a crash');
  assert.match(bad.problem, /atlas\.json/, 'and the reason names the pack that is missing');
  touch(path.join(root, 'slow', 'packs', 'assets', 'atlas.json'), FAKE_ATLAS);
  assert.ok(reg.refresh({ now: Date.now() + 1000, floor: 0 }).revived.length === 0,
    'the retry clock holds: a failed world is not reparsed every 15 s');
  assert.ok(reg.resolve('slow').problem, 'so it is still the same broken world for now');
  const r = reg.refresh({ now: Date.now() + FAILED_WAIT, floor: 0 });
  assert.deepEqual(r.revived, ['slow'], 'once the cooldown passes, the pack that showed up is used');
  assert.ok(!reg.resolve('slow').problem, 'and the world renders');
});
const FAILED_WAIT = 301000;   // just past the registry's own retry interval for a world that failed

test('a save that vanishes from the root is still served, and is said to be gone', () => {
  const root = at('gone');
  mkWorldAt(root, 'here'); mkWorldAt(root, 'stable');
  const { registry: reg } = openWorldsRoot({ root, defaultSlug: 'stable', cache: at('cache-gone') });
  fs.rmSync(path.join(root, 'here'), { recursive: true, force: true });
  const r = reg.refresh({ now: Date.now() + 600000 });
  assert.deepEqual(r.missing, ['here'], 'the fact is reported');
  assert.ok(reg.resolve('here'), 'and the tabs already looking at it do not go blank mid-pan: a folder '
    + 'that is briefly absent is usually a re-sync in progress');
  assert.ok(reg.slugs().includes('here'), 'still listed, because hiding it would be the same lie');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
