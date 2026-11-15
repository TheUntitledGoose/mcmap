// Two worlds, one running server, one payload cache: the point of M18, proven with the real save.
//
// Why copies of two region files instead of the whole 3.3 GB save: the claim under test is about
// *identity and routing*, and it needs two saves whose region bytes are identical in one place and
// different in another. So `full` gets r.0.0 and r.0.1, and `half` gets r.0.0 only - same level.dat,
// same atlas, one region file apart. Everything about that difference has to come from the bytes:
// the same chunk answers identically for both, a chunk in the region `half` never got answers for
// one and not the other, and each save's payloads sit under their own directory in one shared cache.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openWorld } from '../server/world-bundle.mjs';
import { worldTagFor } from '../shared/world-tag.mjs';

const SRC = 'DarkRPG/world';
const PORT = 8900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmap-worlds-http-'));
const cache = path.join(root, 'cache');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function stage(slug, regions) {
  const save = path.join(root, slug, 'save');
  copy(path.join(SRC, 'level.dat'), path.join(save, 'world', 'level.dat'));
  for (const r of regions) copy(path.join(SRC, 'region', r), path.join(save, 'world', 'region', r));
  // Same atlas for both - that is the point: the state table cannot be what keeps them apart.
  for (const f of ['atlas.json', 'atlas.png', 'geometry.bin']) {
    copy(path.join('build', 'assets', f), path.join(root, slug, 'packs', 'assets', f));
  }
  return {
    world: path.join(save, 'world'),
    assets: path.join(root, slug, 'packs', 'assets'),
  };
}

const FULL = stage('full', ['r.0.0.mca', 'r.0.1.mca']);
const HALF = stage('half', ['r.0.0.mca']);
// The chunk that lives in the region only one of the two saves was given, found by the first test and
// asked about by the later ones over HTTP.
let ONLY_FULL = null;

const get = async (p) => {
  const r = await fetch(BASE + p);
  const buf = Buffer.from(await r.arrayBuffer());
  return { code: r.status, buf, text: buf.toString('utf8') };
};

test('the same chunk in two saves answers identically, and a chunk only one of them has answers once', async () => {
  const A = openWorld({ slug: 'full', paths: FULL, cache, worldTag: 'full' });
  const B = openWorld({ slug: 'half', paths: HALF, cache, worldTag: 'half' });
  assert.ok(A.svc && B.svc, 'both opened');
  assert.equal(A.svc.tableTag, B.svc.tableTag, 'the same atlas means the same state table');
  assert.notEqual(A.svc.worldTag, B.svc.worldTag, 'and the world level is what separates their payloads');
  const again = openWorld({ slug: 'full', paths: FULL, cache, worldTag: 'full' });
  assert.equal(again.svc.worldTag, A.svc.worldTag, 'the same world restarted keeps its cache directory');
  // Identity is slug + seed. Two worlds in one root cannot share a slug, so inside one box their tags
  // cannot collide; and the same save pushed to a second box under the same name keeps its payloads,
  // which is the point of putting the name in the tag at all.
  assert.notEqual(worldTagFor({ dir: FULL.world, seed: '1', override: 'x' }),
    worldTagFor({ dir: FULL.world, seed: '2', override: 'x' }),
    'the same slug over a save with a different seed is a different world');
  // Three chunks from the region both saves have. Chosen by asking, not by assuming: r.0.0 has holes in
  // it, and a hole is a legitimate answer that proves nothing about identity.
  const shared = [];
  for (let cz = -8; cz < 24 && shared.length < 3; cz++) {
    for (let cx = -8; cx < 24 && shared.length < 3; cx++) {
      if (A.svc.chunkBytes('minecraft:overworld', cx, cz)) shared.push([cx, cz]);
    }
  }
  assert.equal(shared.length, 3, `r.0.0 has chunks to compare: found ${shared.map((c) => c.join(',')).join(' | ')}`);
  for (const [cx, cz] of shared) {
    const a = A.svc.chunkBytes('minecraft:overworld', cx, cz);
    const b = B.svc.chunkBytes('minecraft:overworld', cx, cz);
    assert.ok(b, `chunk ${cx},${cz} is in the region both saves have`);
    assert.ok(a.length > 100, 'and it is a real chunk, not a hole');
    assert.deepEqual(Buffer.from(b), Buffer.from(a), 'identical region bytes decode identically');
    assert.notEqual(A.svc.cachePath('minecraft:overworld', cx, cz), B.svc.cachePath('minecraft:overworld', cx, cz));
  }
  // A chunk living in the region only `full` was given: present for one, absent for the other.
  let found = null;
  for (let cz = 32; cz < 64 && !found; cz++) {
    for (let cx = 0; cx < 32 && !found; cx++) {
      if (A.svc.chunkBytes('minecraft:overworld', cx, cz)) found = [cx, cz];
    }
  }
  assert.ok(found, 'r.0.1 has at least one chunk to find');
  ONLY_FULL = found;
  assert.equal(B.svc.chunkBytes('minecraft:overworld', found[0], found[1]), null,
    `chunk ${found} exists in the save that has its region file and nowhere else`);
  const tags = fs.readdirSync(cache).filter((d) => !d.startsWith('.'));
  assert.equal(tags.length, 2, `one cache root, two save directories: ${tags.join(', ')}`);
  assert.ok(tags.includes(A.svc.worldTag) && tags.includes(B.svc.worldTag));
});

const child = spawn(process.execPath, ['server/worldd.mjs', '--port', String(PORT), '--host', '127.0.0.1',
  '--worlds', root, '--world-default', 'full', '--cache', cache, '--heartbeat', '0', '--cache-sweep', '0',
  // One test drops a save into the root while this server runs and asks for it immediately; without this
  // the glance interval would make that test a sleep. A real box leaves the default (15 s) alone.
  '--worlds-scan', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/meta`);
      if (r.ok) return JSON.parse(await r.text());
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worldd did not come up:\n${log}`);
}

test('the page is told which worlds exist, and which one it is looking at', async () => {
  const meta = await waitReady();
  assert.equal(meta.slug, 'full', 'the default world is the one the stack named');
  assert.equal(meta.defaultWorld, 'full');
  assert.deepEqual(meta.worlds.map((w) => w.slug), ['full', 'half']);
  assert.ok(meta.worlds.every((w) => w.label && w.worldTag), 'each one is labelled and identifies its cache');
  assert.ok(meta.worlds.find((w) => w.slug === 'half').packed.assets, 'its asset pack arrived');
  assert.equal(meta.worlds.find((w) => w.slug === 'half').packed.shells, false,
    'and the ones that did not are reported, not assumed');
  assert.ok(meta.worlds.find((w) => w.slug === 'full').dims.length >= 1, 'a world reports its own dimensions');
});

test('one request per world, over the wire, with the same bytes for the same chunk', async () => {
  const q = '/voxel?dim=minecraft:overworld&cx=2&cz=2';
  const a = await get(q + '&world=full');
  const b = await get(q + '&world=half');
  assert.equal(a.code, 200);
  assert.equal(b.code, 200);
  assert.ok(a.buf.length > 100);
  assert.deepEqual(b.buf, a.buf, 'the wire answers for the same chunk of two identical saves are identical');
  const half = JSON.parse((await get('/stats?world=half')).text);
  assert.equal(half.slug, 'half');
  const full = JSON.parse((await get('/stats?world=full')).text);
  assert.equal(full.slug, 'full');
  assert.notEqual(half.worldTag, full.worldTag);
  assert.deepEqual(half.worlds, ['full', 'half'], 'and either world\'s heartbeat knows the whole set');
});

test('a world that does not exist is refused by name, and never answered with the default world', async () => {
  for (const p of ['/voxel?dim=minecraft:overworld&cx=2&cz=2&world=nope', '/meta?world=nope',
    '/regions?dim=minecraft:overworld&world=nope', '/embed.png?world=nope', '/stats?world=nope',
    '/voxels?dim=minecraft:overworld&cx0=0&cz0=0&w=1&h=1&world=nope',
    '/assets/atlas.json?world=nope', '/skins/strip.json?world=nope', '/lod/0/0/0/0?world=nope']) {
    const r = await get(p);
    assert.equal(r.code, 404, `${p} answered ${r.code}`);
    assert.match(r.text, /nope/, 'it says which name it refused');
    assert.match(r.text, /full/, 'and it lists the worlds that do exist');
  }
  // The page is the one place a bad slug is answered with a page: the map can then say "not on this
  // box - these are" and offer them, which beats a wall of text. Every data route above still refuses.
  const page = await get('/?world=nope');
  assert.equal(page.code, 200);
  assert.match(page.text, /<title>/);
});

test('a pack or a region file that never arrived for one world is that world\'s problem, not the server\'s', async () => {
  // Shells are not only a baked pack: without one the server derives the heightmap frame from that
  // world's own payloads. So the world that never got r.0.1 answers "nothing there" for a chunk its
  // neighbour has ground in, and does not borrow the neighbour's answer.
  assert.ok(ONLY_FULL, 'the first test found a chunk that exists in one save only');
  const [cx, cz] = ONLY_FULL;
  const q = `/shells?dim=minecraft:overworld&cx0=${cx}&cz0=${cz}&w=1&h=1`;
  const here = await get(q + '&world=full');
  const there = await get(q + '&world=half');
  assert.equal(here.code, 200);
  assert.ok(here.buf.length > 64, `a real frame for ${cx},${cz}: ${here.buf.length} bytes`);
  assert.equal(there.code, 200);
  assert.ok(there.buf.length < here.buf.length,
    `the other save answered ${there.buf.length} bytes against ${here.buf.length}: it knows it has no such chunk`);
  const atlas = await get('/assets/atlas.json?world=half');
  assert.equal(atlas.code, 200, 'the pack that did arrive still serves this world');
  assert.equal(atlas.buf.length, fs.statSync(path.join(root, 'half', 'packs', 'assets', 'atlas.json')).size);
  // Those packs are outside the repo directory now, which is exactly what the multi-world layout asks
  // for, so the containment rule had to move from "inside the repo" to "inside a root this process was
  // told about". A climb out of the pack is still a 404.
  const climb = await get('/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fserver%2fworldd.mjs?world=half');
  assert.equal(climb.code, 404, 'a percent-encoded ../ out of the pack must not serve the server source');
  const climb2 = await get('/skins/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.equal(climb2.code, 404);
});

test('the card and the favicon follow the world that was asked for', async () => {
  const page = await get('/?world=half');
  assert.equal(page.code, 200);
  assert.match(page.text, /<meta property="og:title" content="[^"]*"/, 'a card is still written');
  const half = page.text.match(/<meta property="og:title" content="([^"]*)"/)[1];
  const other = (await get('/?world=full')).text.match(/<meta property="og:title" content="([^"]*)"/)[1];
  assert.notEqual(half, other, 'and it describes the world in the link, not whichever one booted first');
});

test('a save dropped into the worlds root while the server runs is served without a restart', async () => {
  // The deployment story in one test: a folder lands on the mounted share, nobody restarts anything, and
  // the next link that names it works. Everything here is real decode work - a copy of one region file,
  // its own atlas copy, and a payload written under its own cache identity.
  stage('dropped', ['r.0.0.mca']);
  const hit = await get('/voxels?dim=minecraft:overworld&cx0=0&cz0=0&w=2&h=2&world=dropped');
  assert.equal(hit.code, 200, 'a request for a slug nobody had heard of made the registry look again');
  assert.ok(hit.buf.length > 100000, `and it answered with payloads, got ${hit.buf.length} B`);
  const m = JSON.parse((await get('/meta')).text);
  const list = m.worlds.map((w) => w.slug);
  assert.ok(list.includes('dropped'), `the page would offer it now: ${list.join(', ')}`);
  const own = m.worlds.find((w) => w.slug === 'dropped');
  assert.notEqual(own.worldTag, m.worlds.find((w) => w.slug === 'full').worldTag,
    'a save that is a copy of another still gets its own cache identity');
  assert.ok(fs.existsSync(path.join(cache, own.worldTag)),
    'and what it decoded is filed under that name, not under the save it was copied from');
});

after(() => {
  child.kill();
  // The staged saves are copies of two region files in a temp directory; nothing of yours is in there.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows can be slow to let go */ }
});
