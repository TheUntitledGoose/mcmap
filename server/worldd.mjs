// worldd — the Node side of the renderer: serves packed assets and decoded chunk payloads.
//   node server/worldd.mjs [--world DarkRPG/world] [--assets build/assets] [--port 8765]
//                          [--host 0.0.0.0]        (--host 127.0.0.1 to keep it local only)
//
// Every flag below can also be set from the environment as WD_<NAME>, dashes to underscores:
//   WD_WORLD=/data/world WD_CACHE=/data/cache WD_PORT=8765 WD_LEDGER=none
// That is how the container configures itself (see Dockerfile): a command line baked into an image
// is invisible in Portainer's UI, a variable is not. An unknown WD_* stops the boot rather than
// being ignored, because "I set the volume path and nothing moved" is the worst kind of quiet.
// Routes:
//   GET /meta                       world extent, dimensions, spawn, asset summary
//   GET /voxel?dim&cx&cz            one chunk payload (binary, gzip when accepted)
//   GET /voxels?dim&cx0&cz0&w&h     a rectangle of payloads in one container frame
//   GET /shell?dim&cx&cz            one heightmap shell frame (~1 KB)
//   GET /shells?dim&cx0&cz0&w&h     a rectangle of shell frames
//   GET /overview?dim=...           the whole dimension as one decimated heightmap frame
//   GET /ledger/meta                the block-history index: players, dimensions, coverage
//   GET /ledger/cells?dim=...       sparse per-chunk activity table (binary, 32 B per touched chunk)
//   GET /ledger/timeline?dim=...    this dimension's rows in time order (binary, 14 B per row)
//   GET /ledger/rows?dim&cx&cz      what happened in one chunk, oldest first (JSON)
//   GET /ledger/top?dim&cls&player  where the action is, most-changed chunks first (JSON)
//   GET /assets/<file>              atlas.json / atlas.png / geometry.bin
//   GET /embed.png                  the picture a chat link shows (yours if build/embed.png exists)
//   GET /*                          the web app
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { WorldService, compress } from './world-service.mjs';
import { atlasStamp } from './shell-pack.mjs';
import { pruneCache } from './cache-prune.mjs';
import { buildStateIds } from './chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { LOD_CELL } from '../shared/lod-format.mjs';
import { summarizeLodDir } from './lod-pack.mjs';
import { LedgerService } from './ledger-service.mjs';
import { envArgs } from '../shared/envargs.mjs';
import { skinStripFor, stripJson, stripPng } from './skin-strip.mjs';
import { urlBase, pageUrl, embedTags, pngSize, fillEmbed } from '../shared/embed.mjs';
import { WORLDD_FLAGS } from './worldd-flags.mjs';
import { openWorld, embedImageFor, packHere } from './world-bundle.mjs';
import { openWorldsRoot, WorldRegistry } from './world-registry.mjs';

// Every flag the server reads lives in server/worldd-flags.mjs, so an environment variable that
// does not name one of them is an error instead of a suggestion. tests/container-contract.test.mjs
// checks that list against the arg()/num() calls actually used here.

// envArgs turns WD_* into the same flags; it goes in front of argv so a typed flag still wins.
const fromEnv = envArgs(process.env).filter((a) => a.startsWith('--')).map((a) => a.slice(2));
const argv = [...envArgs(process.env), ...process.argv.slice(2)];
{
  const bad = [...new Set(fromEnv)].filter((n) => !WORLDD_FLAGS.includes(n));
  if (bad.length) {
    console.error(`worldd: WD_* variables name flags that do not exist: ${bad.map((n) => 'WD_' + n.replace(/-/g, '_').toUpperCase()).join(', ')}`);
    console.error(`        real flags: ${WORLDD_FLAGS.map((f) => '--' + f).join(' ')}`);
    process.exit(2);
  }
}
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = arg(name, null);
  if (v === null || v === '') return dflt;
  const n = +v;
  return Number.isFinite(n) ? n : dflt;
};
const WORLD = arg('world', 'DarkRPG/world');
// M18: a folder of worlds instead of one save. `<root>/<slug>/{save,packs}`; the slug is what `?world=`
// says and what the payload cache directory is called. Left empty (the default, and every container
// deployed so far) and this process is exactly what it always was: one save, no `world=` needed.
const WORLDS = arg('worlds', '');
const WORLD_DEFAULT = arg('world-default', '');
const ASSETS = arg('assets', 'build/assets');
const CACHE = arg('cache', 'build/cache');
const WEB = arg('web', 'web');
const VENDOR_DIR = arg('vendor', path.join('node_modules', 'three', 'build'));
const LEDGER = arg('ledger', 'build/ledger');
const PORT = +arg('port', 8765);
// All interfaces by default: the point of the renderer is that it runs in any browser, including one
// on another machine. `--host 127.0.0.1` puts it back behind loopback. Note what that means — there is
// no auth here, so on 0.0.0.0 anyone who can reach this port can read the entire world save.
const HOST = arg('host', '0.0.0.0');

// The addresses worth typing on another machine, for the banner.
const lanAddrs = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
  .map((i) => i.address);

// The asset pack, the state table and the classification tables are opened per world, in
// server/world-bundle.mjs - see `openWorld` below. What used to be here was a module-scope `atlas`,
// `stateIds` and `stateCls`, which is exactly the shape that made one process one save.

// Shell packs (server/bake-shells.mjs) turn the far view into a file read. Missing, or baked against
// a different atlas, and the service derives shells from chunk payloads the slow way.
const PACKS = arg('packs', 'build/shells');
// Baked coarse LOD tiles (server/bake-lod.mjs): the far world as pre-made vertex streams. Missing,
// and the browser keeps meshing its far layers live, which is the behaviour before this existed.
const LODS = arg('lods', 'build/lods');
// Player skins, fetched once by tools/fetch-skins.mjs and composed into one strip by server/skin-strip.mjs.
// Optional by design: with no pack the people stand in their own colour, as they always did. This is the
// only place skins are read - the browser is never pointed at Mojang - and one strip means one texture
// upload and one material for the whole cast instead of one per player.
const SKINS = arg('skins', 'build/skins');
// Which save the payload cache belongs to. Normally derived (see shared/world-tag.mjs); named here once
// a box serves more than one world, so the cache directory carries the name a person chose rather than a
// hash of where the save happens to live.
const WORLD_TAG = arg('world-tag', '');

// What a chat link becomes. The tags are written per request (see shared/embed.mjs); these three flags
// exist for the deployments where guessing from the request is wrong - behind a proxy that rewrites
// Host, or when you want the card to say something the save cannot work out for itself.
const EMBED_URL = arg('embed-url', '');
const EMBED_TITLE = arg('embed-title', '');
const EMBED_DESC = arg('embed-desc', '');
const EMBED_IMAGE = arg('embed-image', '');
/**
 * One world, from the flags - the shape every deployment has used so far - or every world under a
 * `--worlds` root. Either way the result is a WorldRegistry of `world-bundle.mjs` objects, and every
 * route below resolves which one a request means instead of reading module-scope singletons.
 */
const NOCACHE = CACHE === 'none' ? null : CACHE;
const CACHE_MAX_GB = num('cache-max-gb', 2);
const DEFAULT_CARD = path.join(WEB, 'img', 'embed.png');

const REG = (WORLDS === '' || WORLDS === 'none')
  ? new WorldRegistry({
    bundles: [openWorld({
      slug: '', dir: path.dirname(path.resolve(WORLD)),
      paths: { world: WORLD, assets: ASSETS, shells: PACKS, lods: LODS, ledger: LEDGER,
        skins: SKINS, embed: null, defaultEmbed: DEFAULT_CARD },
      cache: NOCACHE, cacheMaxGb: CACHE_MAX_GB, worldTag: WORLD_TAG,
    })],
    defaultSlug: '',
  })
  : openWorldsRoot({
    root: WORLDS, defaultSlug: WORLD_DEFAULT, cache: NOCACHE, cacheMaxGb: CACHE_MAX_GB,
    defaultEmbed: DEFAULT_CARD,
    // How often the worlds root is re-looked at while running. 0 means "every time something asks", which
    // is what the multi-world HTTP test uses so it does not sleep for 15 s; a real box leaves it alone.
    refreshTtlMs: Math.max(0, +arg('worlds-scan', 15000) || 0),
    // How many of them may stand OPEN at once. A worlds root is a folder of saves and people drop saves
    // into folders: at boot every world opened parsed its atlas, decoded its spawn chunk and armed its
    // own region-file LRU (48 files) and payload caches, and none of that is what a link asks for. The
    // rest are listed - named in /meta, in the dropdown, kept out of the cache sweep - and open when a
    // request first names them. 0 means no cap: open all of them, as before.
    maxOpen: Math.max(0, +arg('worlds-max', 4) || 0),
    // The registry is the thing that notices a save arrived, that a late pack fixed a broken one, that a
    // link just opened a world this box was holding closed, and that the cap closed the idlest one. All of
    // that is invisible unless it is said out loud: someone watching the log while they copy a save has to
    // see the box react to it, the same way the heartbeat says when the set of worlds changes.
    // closed, and the cap closed the idlest one. All of that is invisible unless it is said out loud: an
    // operator watching the log while they copy a save has to see the box react to it.
    log: (m) => console.log('  worlds: ' + m),
  }).registry;

// A world that will not open is reported and skipped, not fatal - unless it is the only one and it is
// the save the operator named, in which case there is nothing else on this box to serve and the boot
// ends with the sentence that says what to bake or mount.
for (const p of REG.problems) console.error(`worldd: ${p}`);
const DEF = REG.default;
if (!DEF || DEF.problem) {
  console.error(`worldd: ${DEF ? DEF.problem : 'no world to serve'}`);
  process.exit(1);
}


// `--cache-sweep 0` keeps old generations on purpose (comparing two atlas stamps side by side).
// The keep lists cover every world this process opens: a payload tree belonging to a world that is no
// longer on disk is dead weight, and one belonging to a world that IS here is never touched.
if (NOCACHE && num('cache-sweep', 1) !== 0) {
  // Every world this registry will answer about, holding files or not: a world the cap keeps closed is
  // still a save on this box, and its payloads are exactly what it will need when a request names it.
  const r = pruneCache(NOCACHE, {
    keepTags: REG.cacheKeepTables(),
    keepWorlds: REG.cacheKeep(),
    tableOwners: REG.cacheTableOwners(),
    keepHours: num('cache-keep-h', 24),
    log: (m) => console.log('  cache: ' + m),
  });
  if (r.files) console.log('  cache: swept ' + r.files + ' unreachable files, ' + (r.bytes / 1e9).toFixed(2) + ' GB');
  // A cache tree under an old name for a live save is kept on purpose, and said so: the alternative is a
  // quiet 25-minute re-decode that the operator reads as the viewer having gotten slower.
  if (r.renamed?.length) {
    console.log('  cache: kept ' + r.renamed.length + ' cache tree' + (r.renamed.length === 1 ? '' : 's')
      + ' filed under a name this box no longer uses (' + r.renamed.map((n) => n.dir).join(', ')
      + ', ' + (r.renamed.reduce((s, n) => s + n.bytes, 0) / 1e9).toFixed(2) + ' GB)'
      + ' - the line above says how to move ' + (r.renamed.length === 1 ? 'it' : 'them') + ' with tools/cache-retag.mjs');
  }
}

// Reconcile the payload cache against its byte budget in the background, once, after the first requests
// are being served. This used to happen inside the write path as a synchronous walk of the whole tree,
// which is how a busy pan could freeze the server for over a minute (build/dbg-cachewalk.mjs timed that
// walk at 98 s for 665 427 files). `--cache-reconcile 0` skips it; tools/cache-prune.mjs is the offline
// version of the same job.
if (NOCACHE && num('cache-reconcile', 1) !== 0) {
  setTimeout(() => {
    for (const b of REG.bySlug.values()) {
      if (b.problem || b.notOpen) continue;   // a parked world has no service to sweep with
      b.svc.sweepCacheBudget().catch((e) => console.log('  cache: reconcile failed: ' + (e.message ?? e)));
    }
  }, 5000).unref();
}

// The skin pack and level.dat are read per world, by the bundle (`W.skins()`, `W.level()`,
// `W.skinSummary()`): a second save has its own cast and its own version, and one module-scope memo
// would answer for both. What stays here is the encoding of the strip for the wire (stripJson/stripPng).


/*
 * The card a chat link becomes.
 *
 * A bot fetches this HTML and reads `<meta>`; it never runs the page. So the tags are written here,
 * per request, from the address the bot used - and the image is served by this server too, because a
 * tag pointing at a relative path is a tag pointing at nothing. A deployment that bakes its own picture
 * (a screenshot of its own world, say) drops it at build/embed.png and this answers with that instead,
 * no rebuild: the same "mount a pack, not an image" rule as the shells and the skins.
 */
const EMBED_MARK = '<!--embed-->';

/**
 * The card, per world. A deployment's own picture wins over the drawn default (`embedImageFor`), the
 * title names the save this request is about, and the description is assembled from what that world
 * actually has - never from a bounding box, because a bounding box is a rectangle and a world is not.
 */
function embedImageFile(W) { return embedImageFor(W.paths, EMBED_IMAGE); }

function embedTitle(W) {
  if (EMBED_TITLE) return EMBED_TITLE;
  return `${W.label}: the whole save in a browser tab`;
}

function embedDescription(W) {
  if (EMBED_DESC) return EMBED_DESC;
  const lv = W.level();
  const dims = W.svc.dimList();
  const rows = W.ledger.ready ? (W.ledger.loadMeta()?.totalRows ?? 0) : 0;
  const save = `${lv.version ? `Minecraft ${lv.version} ` : ''}save, ${dims.length} dimension${dims.length === 1 ? '' : 's'}`;
  const what = 'streamed into a browser tab \u2014 pan the whole world, walk it in first person';
  const when = rows ? `, and step back through ${Number(rows).toLocaleString('en-US')} logged block changes` : '';
  return `${save}: ${what}${when}.`;
}

function embedHead(req, u, W) {
  const at = {
    override: EMBED_URL,
    forwardedHost: req.headers['x-forwarded-host'], host: req.headers.host,
    forwardedProto: req.headers['x-forwarded-proto'], secure: !!req.socket?.encrypted,
    fallback: `127.0.0.1:${PORT}`,
  };
  // The path is canonicalised - /index.html and / are the same page, and the card shows the one a person
  // would type - while the query survives, so a card made from a saved framing opens that framing.
  const url = pageUrl({
    ...at,
    path: u.pathname === '/index.html' ? '/' : u.pathname,
    search: u.search || '',
  });
  const file = embedImageFile(W);
  return embedTags({
    title: embedTitle(W), description: embedDescription(W), url,
    image: file ? `${urlBase(at)}/embed.png` : null,
    size: file ? pngSize(fs.readFileSync(file)) : null,
  });
}

/** The page, with this request's card written into it. */
let embedWarned = -1;
function embedPage(req, u, W) {
  const file = path.join(WEB, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const r = fillEmbed(html, EMBED_MARK, embedHead(req, u, W));
  if (!r.filled && embedWarned !== r.marks) {
    embedWarned = r.marks;
    console.log(`worldd: ${file} carries ${r.marks} \`${EMBED_MARK}\` marker(s), expected exactly 1 - ` +
      'a link preview would show no card (see shared/embed.mjs)');
  }
  return r.html;
}

/**
 * Chunk coordinates must be present numbers. The old code passed them straight through: a missing
 * parameter reads as `+null === 0`, and a mistyped one as NaN - which is also 0 once it goes through
 * `>> 5`. So `/voxels?...&cx=-366` was served chunk (0,0) with a 200, indistinguishable from real
 * data both on the wire and in a probe that made the same typo.
 */
function coord400(q, ...names) {
  for (const n of names) {
    const v = q.get(n);
    if (v === null || v === '' || !Number.isFinite(+v)) return `${n}: expected a chunk coordinate, got '${v ?? ''}'`;
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.map': 'application/json',
};

function send(req, res, code, body, type, extra = {}) {
  const headers = { 'Cache-Control': 'no-cache', ...extra };
  if (body && !Buffer.isBuffer(body)) body = Buffer.from(body);
  if (body && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && type !== 'image/png') {
    body = compress(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body ? body.length : 0;
  headers['Content-Type'] = type ?? 'application/octet-stream';
  // Stash the size where it is known: by the time 'finish' fires, getHeader('Content-Length') is not a
  // reliable read on every Node, and a NaN there used to zero the whole byte column of /stats. This is
  // the payload size, before the gzip this same function may apply - it answers "what is big", not
  // "what hit the wire".
  res.__sent = body ? body.length : 0;
  res.writeHead(code, headers);
  res.end(body);
}

function serveFile(res, req, file, allow = []) {
  const p = path.resolve(file);
  // The repo rule is what stops `/assets/../../../etc/passwd`. A world's packs are NOT inside the repo
  // in the multi-world layout (`/data/worlds/<slug>/packs/...`), so the roots this process was told
  // about are allowed as well - and only those, still resolved, still containment-checked.
  const inside = (r) => r && (p === path.resolve(r) || p.startsWith(path.resolve(r) + path.sep));
  if (!inside(process.cwd()) && !allow.some(inside)) return send(req, res, 404, 'outside the served roots', 'text/plain');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(req, res, 404, 'not found', 'text/plain');
  const body = fs.readFileSync(p);
  const type = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
  // assets are content-addressed by the pack run; chunks are immutable per session
  const cache = (p.startsWith(path.resolve(ASSETS)) || p.startsWith(path.resolve(VENDOR_DIR)))
    ? 'public, max-age=86400' : 'no-cache';
  send(req, res, 200, body, type, { 'Cache-Control': cache });
}

// "The server stopped loading chunks" used to be unanswerable from the log: there were global counters
// but no per-path cost, so one request taking 30 s and the whole process being stuck for 30 s looked
// identical (and both were true at different times). Now every path is counted, anything slower than
// --slow-ms is logged with the parameters that reproduce it, and the heartbeat names whatever request
// has been in flight for more than two seconds.
const SLOW_MS = num('slow-ms', 400);
const REQ = new Map();            // path -> { n, ms, max, bytes, slow }
const INFLIGHT = new Map();       // seq -> { tag, since }
let reqSeq = 0;

// Just enough of the query to replay the request; the asset and vendor paths carry nothing useful.
function reqTag(u) {
  const q = u.searchParams, p = u.pathname;
  // Which world this request is about, when the request said so: a slow line that names the save is the
  // difference between "the server is slow" and "that save is cold".
  const ws = q.get('world') ? ` world=${q.get('world')}` : '';
  if (p === '/voxels' || p === '/shells') {
    return `${p} ${q.get('dim') ?? '-'} ${q.get('cx0')},${q.get('cz0')} ${q.get('w')}x${q.get('h')}${ws}`;
  }
  if (p === '/lod') return `${p} ${q.get('dim') ?? '-'} cell=${q.get('cell')} ${q.get('rx')},${q.get('rz')}${ws}`;
  if (p === '/voxel' || p === '/shell') return `${p} ${q.get('dim') ?? '-'} ${q.get('cx')},${q.get('cz')}${ws}`;
  return p + ws;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = u.searchParams;
  const seq = ++reqSeq;
  const tag = reqTag(u);
  const t0 = performance.now();
  INFLIGHT.set(seq, { tag, since: t0 });
  let counted = false;
  const count = () => {
    if (counted) return;
    counted = true;
    INFLIGHT.delete(seq);
    const ms = performance.now() - t0;
    const e = REQ.get(u.pathname) ?? { n: 0, ms: 0, max: 0, bytes: 0, slow: 0 };
    e.n++; e.ms += ms; e.bytes += res.__sent ?? 0;
    if (ms > e.max) e.max = ms;
    if (ms >= SLOW_MS) e.slow++;
    REQ.set(u.pathname, e);
    if (ms >= SLOW_MS) {
      console.log(`  slow ${tag}: ${ms.toFixed(0)} ms, ${((+res.getHeader('Content-Length') || 0) / 1024).toFixed(0)} KB, code ${res.statusCode}`);
    }
  };
  res.on('finish', count);
  res.on('close', count);
  try {
    // Which save does this request mean? `?world=<slug>` in a multi-world process, the one save otherwise.
    // An unknown slug is a 404 that names what does exist: answering it with the default world would put
    // a different save on screen than the one the person asked for, with nothing on screen saying so.
    const W0 = REG.resolve(q.get('world'));
    // A *page* request with an unknown slug still gets the page, on the default world: the browser can
    // then say "that world is not on this box - these are" inside the map instead of as a wall of text,
    // and the person can pick one. Every data route still refuses, because answering a data request
    // with a different save than was asked for is the failure this whole arrangement exists to prevent.
    const W = W0 ?? ((u.pathname === '/' || u.pathname === '/index.html') ? REG.default : null);
    if (!W) return send(req, res, 404, REG.whyMiss(q.get('world')), 'text/plain');
    if (W.problem) return send(req, res, 503, `${W.slug || W.paths.world}: ${W.problem}`, 'text/plain');
    const svc = W.svc, ledger = W.ledger;
    // Where the time actually goes: a decode is 25 ms of work hidden behind a 0.1 ms file read, and
    // a regionOpen means the payload cache did not absorb the request.
    if (u.pathname === '/stats') {
      const byPath = {};
      for (const [p, e] of REQ) {
        byPath[p] = { n: e.n, ms: +e.ms.toFixed(0), max: +e.max.toFixed(0), slow: e.slow,
          kb: +(e.bytes / 1024).toFixed(0) };
      }
      send(req, res, 200, JSON.stringify({ ...svc.stats, slug: W.slug, label: W.label,
        worldTag: svc.worldTag, tableTag: String(svc.tableTag),
        packsOpen: svc.packs.size,
        worlds: REG.list().map((x) => x.slug ?? ''),
        // One row per save: what it costs while open (region handles, pack buffers, decoded far frames,
        // LOD tiles), and nothing where the cap keeps it closed. Without this, "why is this process
        // 600 MB" on a box that lists twelve saves has no answer.
        perWorld: REG.perWorld(),
        inflight: INFLIGHT.size, byPath }), 'application/json');
      return;
    }
    if (u.pathname === '/skins/strip.json' || u.pathname === '/skins/strip.png') {
      const s = W.skins();
      if (!s) return send(req, res, 404, '{"error":"no skin pack"}', 'application/json');
      if (u.pathname.endsWith('.png')) {
        return send(req, res, 200, stripPng(s.strip), 'image/png', { 'Cache-Control': 'no-cache' });
      }
      return send(req, res, 200, JSON.stringify(stripJson(s.strip, s.pack)), 'application/json; charset=utf-8');
    }
    if (u.pathname === '/meta') {
      // A save dropped into the worlds root since boot shows up here, which is what makes the page's save
      // list true without a restart. Rate-limited inside the registry, and it is a readdir plus (only when
      // something is genuinely new) one atlas parse, so the cost of asking every few seconds is nil.
      REG.refresh();
      return send(req, res, 200, JSON.stringify({
        world: W.paths.world, slug: W.slug, label: W.label, worldTag: svc.worldTag,
        level: W.level(), dims: svc.dimList(),
        // M18: what this box offers. The page turns this into a World choice, and a world that failed to
        // open is listed with its problem rather than hidden - so "where is my other save" is answerable
        // from the browser instead of from the container log.
        worlds: REG.list(), defaultWorld: REG.defaultSlug || '',
        // Opened here, no longer on disk: a re-sync in progress. Still served, and said out loud.
        worldMissing: [...REG.missing],
        assets: { states: W.atlas.states.length, textures: W.atlas.textures.length,
          atlasSize: W.atlas.atlasSize, geometry: W.atlas.geometry },
        stats: svc.stats,
        packed: { shells: !!W.paths.shells && fs.existsSync(W.paths.shells), lod: W.lodSummary,
          ledger: ledger.ready, skins: W.skinSummary() },
        coverage: { ttlMs: svc.coverageTtlMs },
      }), 'application/json; charset=utf-8');
    }
    if (u.pathname === '/regions') {
      // Region coverage for one dimension. The browser uses it to stop asking for ground this save
      // never had, which over the whole bounding box is most of the map.
      const wire = svc.coverageWire(q.get('dim') ?? 'minecraft:overworld');
      return send(req, res, wire ? 200 : 404, wire ? JSON.stringify(wire) : '{"error":"no regions"}', 'application/json');
    }
    if (u.pathname === '/voxel') {
      const bad = coord400(q, 'cx', 'cz');
      if (bad) return send(req, res, 400, bad, 'text/plain');
      const b = svc.chunkBytes(q.get('dim') ?? 'minecraft:overworld', +q.get('cx'), +q.get('cz'),
        { fresh: q.get('fresh') === '1' });
      if (!b) return send(req, res, 404, Buffer.alloc(0), 'application/octet-stream');
      return send(req, res, 200, b, 'application/octet-stream');
    }
    if (u.pathname === '/voxels') {
      const bad = coord400(q, 'cx0', 'cz0');
      if (bad) return send(req, res, 400, bad, 'text/plain');
      // Awaited: a ring of payloads can be a few hundred chunk decodes, and the loop must stay free
      // for the requests that came in behind it.
      const b = await svc.batchBytesAsync(q.get('dim') ?? 'minecraft:overworld', +q.get('cx0'),
        +q.get('cz0'), Math.min(64, +q.get('w') ?? 1), Math.min(64, +q.get('h') ?? 1));
      return send(req, res, 200, b, 'application/octet-stream');
    }
    if (u.pathname === '/shell') {
      const bad = coord400(q, 'cx', 'cz');
      if (bad) return send(req, res, 400, bad, 'text/plain');
      const b = svc.shellBytes(q.get('dim') ?? 'minecraft:overworld', +q.get('cx'), +q.get('cz'));
      if (!b) return send(req, res, 404, Buffer.alloc(0), 'application/octet-stream');
      return send(req, res, 200, b, 'application/octet-stream');
    }
    if (u.pathname === '/shells') {
      const bad = coord400(q, 'cx0', 'cz0');
      if (bad) return send(req, res, 400, bad, 'text/plain');
      // A 16x16 tile of shells is ~256 KB, which is why the far view can cover a wide radius.
      const b = await svc.shellBatchBytesAsync(q.get('dim') ?? 'minecraft:overworld', +q.get('cx0'), +q.get('cz0'),
        Math.min(64, +q.get('w') ?? 1), Math.min(64, +q.get('h') ?? 1));
      return send(req, res, 200, b, 'application/octet-stream');
    }
    if (u.pathname === '/lodindex') {
      return send(req, res, 200, JSON.stringify({ tiles: svc.lodIndex(q.get('dim') ?? 'minecraft:overworld') }),
        'application/json; charset=utf-8');
    }
    if (u.pathname === '/lod') {
      // One baked region tile (32x32 chunks) at one rung of the ladder - `cell` blocks per column -
      // already inflated. Absent rung is a 404, and the index says which rungs exist so a viewer does
      // not go asking for one the dimension never had.
      const b = svc.lodBytes(q.get('dim') ?? 'minecraft:overworld', +q.get('cell') || LOD_CELL,
        +q.get('rx'), +q.get('rz'));
      return b ? send(req, res, 200, b, 'application/octet-stream')
        : send(req, res, 404, 'no lod tile (run node server/bake-lod.mjs)', 'text/plain');
    }
    if (u.pathname === '/overview') {
      const b = svc.overviewBytes(q.get('dim') ?? 'minecraft:overworld');
      return b ? send(req, res, 200, b, 'application/octet-stream')
        : send(req, res, 404, 'no overview (run node server/bake-shells.mjs)', 'text/plain');
    }
    if (u.pathname === '/ledger/meta') {
      return send(req, res, 200, JSON.stringify(ledger.metaJson()), 'application/json; charset=utf-8');
    }
    if (u.pathname === '/ledger/cells') {
      const b = ledger.cellsBytes(q.get('dim') ?? 'minecraft:overworld');
      return b ? send(req, res, 200, b, 'application/octet-stream')
        : send(req, res, 404, 'no ledger index for that dimension', 'text/plain');
    }
    if (u.pathname === '/ledger/timeline') {
      // Opt-in on purpose: 4.9 MB of rows for the overworld. The heat layer costs 691 KB and is drawn
      // by default; this is the time machine, and a viewer that does not scrub should not pay for it.
      const b = ledger.timelineBytes(q.get('dim') ?? 'minecraft:overworld');
      return b ? send(req, res, 200, b, 'application/octet-stream')
        : send(req, res, 404, 'no ledger timeline for that dimension', 'text/plain');
    }
    if (u.pathname === '/ledger/rows' || u.pathname === '/ledger/top') {
      const dim = q.get('dim') ?? 'minecraft:overworld';
      const opt = {
        cls: +q.get('cls') || 0,
        player: +q.get('player') || 0,
        limit: Math.min(500, +q.get('limit') || 0),
      };
      // `near=x,y,z` (BLOCK coordinates) asks for the rows closest to a voxel. A malformed one is a 400
      // rather than a silent drop: the answer would otherwise look like "no row touches here", which is the
      // exact wrong answer to give someone who is holding the card that shows their typo.
      let near = null;
      const nearQ = q.get('near');
      // !== null, not truthiness: `near=` is a caller that meant to aim and sent nothing, and answering
      // that as "no aim" is what made the old reply look like a fact about the log.
      if (u.pathname === '/ledger/rows' && nearQ !== null) {
        const parts = nearQ.split(',');
        const nums = parts.map((s) => +s);
        if (parts.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
          return send(req, res, 400, `near: expected x,y,z block coordinates, got '${nearQ}'`, 'text/plain');
        }
        near = { x: nums[0], y: nums[1], z: nums[2] };
      }
      const body = u.pathname === '/ledger/rows'
        ? ledger.rowsAt(dim, +q.get('cx'), +q.get('cz'), { ...opt, limit: opt.limit || 120, near })
        : ledger.topCells(dim, { ...opt, limit: opt.limit || 40, near: q.has('nearx')
          ? { cx: +q.get('nearx') >> 4, cz: +q.get('nearz') >> 4, r: +q.get('r') || 32 } : null });
      if (!body) return send(req, res, 404, 'no ledger index for that dimension', 'text/plain');
      return send(req, res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
    }
    if (u.pathname.startsWith('/assets/')) {
      if (!W.paths.assets) return send(req, res, 404, 'no asset pack for this world', 'text/plain');
      return serveFile(res, req, path.join(W.paths.assets, u.pathname.slice(8)), [W.paths.assets]);
    }
    // the skin manifest and the individual PNGs, for poking at; the page only asks for the strip
    if (u.pathname.startsWith('/skins/')) {
      if (!W.paths.skins) return send(req, res, 404, 'no skin pack for this world', 'text/plain');
      return serveFile(res, req, path.join(W.paths.skins, u.pathname.slice(7)), [W.paths.skins]);
    }
    if (u.pathname.startsWith('/shared/')) return serveFile(res, req, path.join('shared', u.pathname.slice(8)));
    // three is served straight out of node_modules; the build/ dir is self-contained (its
    // three.module.js imports ./three.core.js by relative path).
    if (u.pathname.startsWith('/vendor/')) return serveFile(res, req, path.join(VENDOR_DIR, u.pathname.slice(8)));
    // The card's picture, whatever made it: a deployment's own screenshot at build/embed.png wins over
    // the drawn default, with no rebuild and no restart - the same rule the shells and skins follow.
    if (u.pathname === '/embed.png') {
      const f = embedImageFile(W);
      return f ? serveFile(res, req, f, [path.dirname(f)])
        : send(req, res, 404, 'no embed image: run `node tools/make-embed.mjs`, or put a PNG at build/embed.png', 'text/plain');
    }
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    if (rel === 'index.html') return send(req, res, 200, embedPage(req, u, W), 'text/html; charset=utf-8');
    return serveFile(res, req, path.join(WEB, rel));
  } catch (e) {
    return send(req, res, 500, `error: ${e.message}`, 'text/plain');
  }
});
server.listen(PORT, HOST, () => {
  console.log(`worldd http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    const ips = lanAddrs();
    console.log(`  listening on all interfaces${ips.length ? ` — from another machine: ${ips.map((a) => `http://${a}:${PORT}/`).join('  ')}` : ''}`);
    console.log('  (no auth: anyone who can reach this port can read the world save)');
  }
  // "the directory exists" is a different question from "the pack is here": a container built from a clone
  // has every pack directory present, holding one keep file each. Count the entries, and name the variable
  // a mount should set, so this log answers "did my mount actually arrive?" - per world, because with
  // --worlds a box can hold a save whose packs never arrived.
  const mark = (slug) => (slug === REG.defaultSlug ? '*' : ' ');
  for (const b of REG.bySlug.values()) {
    if (b.notOpen) {
      // Listed, not open: no atlas parsed, no region file touched, nothing to report about packs beyond
      // what is sitting in its folder. The line says so, and says what will open it.
      console.log(`  world ${mark(b.slug)} ${b.slug}  ${b.world}`
        + `  (closed: --worlds-max ${REG.maxOpen} is spent on ${REG.openSlugs().join(' ')}`
        + ` — it opens the first time a request names it)`);
      continue;
    }
    console.log(`  world ${mark(b.slug)} ${b.slug || '(single)'}  ${b.paths.world}` +
      `${b.problem ? `  FAILED: ${b.problem.split('\n')[0]}` : `  (${b.svc.dims.size} dimensions)`}`);
    if (b.problem) continue;
    const sk = b.skinSummary();
    console.log(`  packs  assets ${b.atlas.states.length} states / ${b.atlas.textures.length} textures`
      + ` · shells ${packHere(b.paths.shells)} · lods ${b.lodSummary.tiles} tiles/${b.lodSummary.dims} dims`
      + ` · ledger ${packHere(b.paths.ledger)} files`
      + ` · skins ${sk.available ? `${sk.players} players${sk.without.length ? ` (without: ${sk.without.join(' ')})` : ''}` : 'none'}`);
    if (!packHere(b.paths.shells)) {
      console.log(REG.multi
        ? `         shells: nothing at ${b.paths.shells ?? `the packs folder of world '${b.slug}'`} — bake it (node server/bake-shells.mjs) or drop a pack there`
        : `         shells: nothing at ${b.paths.shells} — mount a pack (WD_PACKS) or run node server/bake-shells.mjs`);
    }
    if (!b.lodSummary.tiles) {
      console.log(REG.multi
        ? `         lods: nothing at ${b.paths.lods ?? `the packs folder of world '${b.slug}'`} — bake it (node server/bake-lod.mjs) or drop a pack there`
        : `         lods: nothing at ${b.paths.lods} — mount a pack (WD_LODS) or run node server/bake-lod.mjs`);
    }
    if (!packHere(b.paths.ledger)) {
      console.log(REG.multi
        ? `         ledger: nothing at ${b.paths.ledger ?? `the packs folder of world '${b.slug}'`} — bake it (npm run bake:ledger) or drop a pack there`
        : `         ledger: nothing at ${b.paths.ledger} — mount a pack (WD_LEDGER) or run npm run bake:ledger`);
    }
    if (!sk.available) console.log(`         skins: ${sk.why ?? 'none'} — tools/fetch-skins.mjs fetches them once, never the browser`);
    console.log(`  cache  ${CACHE === 'none' ? 'off (--cache none)'
      : `${CACHE} as ${b.svc.worldTag}/<table ${b.svc.tableTag}>/${b.svc.lightTag} — from ${b.svc.worldTagFrom}`}`);
    for (const d of b.svc.dimList()) {
      console.log(`    ${d.id.padEnd(24)} regions=${String(d.regions).padStart(4)} chunks<=${d.chunksUpperBound}` +
        ` x=${d.chunkExtent?.minX}..${d.chunkExtent?.maxX} z=${d.chunkExtent?.minZ}..${d.chunkExtent?.maxZ}`);
    }
  }
  if (REG.multi) {
    const t = REG.totals();
    console.log(`  serving ${t.worlds} world(s): ${REG.slugs().join(' ')} - ${t.open} open, ${t.parked} closed until asked`
      + ` (--worlds-max ${REG.maxOpen}${t.parked ? '' : ', no cap needed here'}); the page asks with ?world=<slug>,`);
    console.log(`    an unknown slug is refused by name rather than answered with the default (${REG.defaultSlug}).`);
  }
  for (const p of REG.problems) console.log(`  worlds: ${p}`);
});

// "The server ain't loading" has three possible answers — dead, wedged, or merely slow — and the log
// could not tell them apart (it ended with a clean startup banner and no stack when a process vanished
// silently). So: a 60 s heartbeat with RSS and request-counter deltas, plus a line on the way out.
// Reading it: no exit line but the heartbeat stops = killed from outside (OOM / job teardown);
// heartbeat keeps printing while requests time out = the event loop is blocked; counter deltas say
// what it was busy with. Disable with --heartbeat 0.
const T0 = Date.now();
const HEARTBEAT = Math.max(0, +arg('heartbeat', 60));
if (HEARTBEAT) {
  let prev = { ...REG.totals() };
  // A 1 s timer that only stamps the time is how the loop gets watched: if the callback lands late, the
  // loop was blocked, and by how much. That is the difference between "the server is slow" and "the
  // server is stuck", which is the question the 11/07 incident was about.
  let lastTick = Date.now(), lagMax = 0;
  let knownWorlds = REG.slugs().join(' '), knownMissing = '';
  setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - lastTick - 1000);
    lastTick = now;
  }, 1000).unref();
  setInterval(() => {
    // The worlds root is re-looked at on the registry's TTL, so a save that appeared since boot is billed
    // here like one that was there at boot. The change is detected from the slug set rather than from the
    // refresh's own report, because the thing that found the new save may have been a request instead.
    REG.refresh();
    const here = REG.slugs().join(' '), gone = [...REG.missing].join(' ');
    if (here !== knownWorlds || gone !== knownMissing) {
      const was = knownWorlds;
      knownWorlds = here; knownMissing = gone;
      console.log(`worlds: ${was} -> ${here}`
        + (gone ? ` (no longer on disk, still served: ${gone})` : ''));
    }
    const now = REG.totals();
    const d = [];
    for (const [k, v] of Object.entries(now)) {
      if (typeof v === 'number' && v !== prev[k]) d.push(`${k}+${v - (prev[k] ?? 0)}`);
      prev[k] = v;
    }
    let reqN = 0, slowN = 0;
    for (const e of REQ.values()) { reqN += e.n; slowN += e.slow; }
    // Name the stuck requests, not just that something is stuck: one line saying `/voxels ... 64x64 has
    // been running for 41 s` turns a bug hunt into a bug.
    const stuck = [...INFLIGHT.values()].filter((v) => performance.now() - v.since > 2000)
      .map((v) => `${v.tag} ${(Math.round((performance.now() - v.since) / 100) / 10)}s`);
    console.log(`hb ${Math.round((Date.now() - T0) / 1000)}s rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` +
      ` worlds=${now.worlds} packs=${now.packsOpen} lagMax=${lagMax}ms reqs=${reqN}${slowN ? ` slow=${slowN}` : ''}` +
      `${d.length ? ' ' + d.join(' ') : ''}${stuck.length ? ` INFLIGHT ${stuck.join(' | ')}` : ''}`);
    lagMax = 0;
  }, HEARTBEAT * 1000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  try { process.on(sig, () => { console.log(`worldd: ${sig}, exiting`); process.exit(0); }); } catch { }
}
process.on('uncaughtException', (e) => { console.error('worldd: UNCAUGHT ' + (e && e.stack || e)); process.exit(7); });
process.on('unhandledRejection', (e) => console.error('worldd: unhandled rejection: ' + (e && e.stack || e)));
process.on('exit', (code) => console.log(`worldd: exit code=${code} after ${Math.round((Date.now() - T0) / 1000)}s`));
