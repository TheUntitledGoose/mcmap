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
import { WORLDD_FLAGS } from './worldd-flags.mjs';

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

const atlasPath = path.join(ASSETS, 'atlas.json');
if (!fs.existsSync(atlasPath)) {
  // The asset pack is derived (server/pack-assets.mjs, out of your own 1.20.1 jar) and is not in git, so
  // "absent" is the normal state of a fresh clone or a fresh container. In a container this is the whole
  // user-visible surface: one exit line, then a restart loop. So name both ways to fix it and the variable
  // that a mount would set, instead of printing a path with no verb attached to it.
  console.error(`worldd: no ${atlasPath}`);
  console.error(`  bake it:   node server/pack-assets.mjs build/census.json ${ASSETS}`);
  console.error(`             (needs the save and your own 1.20.1 client jar on this machine)`);
  console.error(`  or mount a baked pack and point the server at it:  --assets <dir>   /   WD_ASSETS=<dir>`);
  process.exit(1);
}
const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
const stateIds = buildStateIds(atlas.states.map(s => s.k));
// The shell builder needs to know which states are full cubes, so a column topped by a flower or
// a sign reports the block under it. Same classification the browser mesher uses.
const stateCls = classifyStates(atlas.states, atlas.textures);
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
// Counted once at startup: the browser's /meta answer for "is there a baked far layer?".
const lodSummary = LODS === 'none' ? { dims: 0, tiles: 0, cells: [] } : summarizeLodDir(LODS);
const stamp = atlasStamp(fs.statSync(path.join(ASSETS, 'atlas.json')), atlas.states.length);
const svc = new WorldService(WORLD, stateIds, CACHE === 'none' ? null : CACHE, {
  isCubeState: (id) => stateCls.cube[id - 1] === 1,
  // A far column needs two different answers: which block may *paint* it, and which one can hold a
  // surface up. They are not the same - water holds a lake skin up but must not paint it blue, and a
  // rose does not hold anything up at all. Both come from the packed atlas, not from block names.
  isPaintState: (id) => stateCls.cube[id - 1] === 1 && stateCls.opaque[id - 1] === 1,
  isSolidState: (id) => stateCls.cube[id - 1] === 1,
  isFilmState: (id) => stateCls.film[id - 1] === 1,
  packDir: PACKS,
  lodDir: LODS === 'none' ? null : LODS,
  stamp,
  // The payload cache is saved CPU, not data: the whole world re-decodes in ~25 min. Left alone it
  // grew to 36 GB of unreachable generations, so it gets a byte budget and a startup sweep.
  // 8 GB was chosen for a dedicated box; this machine also holds a 3.44 GB save and the packs, and the
  // cache reached 2.1 GB / 628k files without ever crossing that budget. 2 GB holds roughly the whole
  // overworld at one light generation (284k chunks x ~3.7 KB), which is what a sweep has to refill.
  cacheMaxGb: num('cache-max-gb', 2),
});

// M12: the block-history index. Optional by design - a world without a ledger (or before
// tools/ledger-export.py has been run) just answers meta with `available: false`.
const ledger = new LedgerService(LEDGER);

// `--cache-sweep 0` keeps old generations on purpose (comparing two atlas stamps side by side).
if (CACHE !== 'none' && num('cache-sweep', 1) !== 0) {
  const r = pruneCache(CACHE, {
    keepTags: [String(svc.tableTag)], keepHours: num('cache-keep-h', 24),
    log: (m) => console.log('  cache: ' + m),
  });
  if (r.files) console.log('  cache: swept ' + r.files + ' unreachable files, ' + (r.bytes / 1e9).toFixed(2) + ' GB');
}

// Reconcile the payload cache against its byte budget in the background, once, after the first requests
// are being served. This used to happen inside the write path as a synchronous walk of the whole tree,
// which is how a busy pan could freeze the server for over a minute (build/dbg-cachewalk.mjs timed that
// walk at 98 s for 665 427 files). `--cache-reconcile 0` skips it; tools/cache-prune.mjs is the offline
// version of the same job.
if (CACHE !== 'none' && num('cache-reconcile', 1) !== 0) {
  setTimeout(() => {
    svc.sweepCacheBudget().catch((e) => console.log('  cache: reconcile failed: ' + (e.message ?? e)));
  }, 5000).unref();
}

// The skin pack, read once and re-read only when the manifest moves. Decoding six 64x64 PNGs per request
// would be silly, and a pack that changed under a running server (someone ran tools/fetch-skins.mjs) has
// to be picked up without a restart, so the key is the manifest's mtime.
let skinCache = null;
function skinsNow() {
  if (SKINS === 'none') return null;
  const r = skinStripFor(SKINS);
  if (!r.pack) return null;
  if (!skinCache || skinCache.mtime !== r.mtime) skinCache = r;
  return skinCache;
}
function skinsSummary() {
  const s = skinsNow();
  if (!s) return { available: false, why: SKINS === 'none' ? 'skins disabled' : `no pack under ${SKINS}: run tools/fetch-skins.mjs` };
  return {
    available: true, generated: s.pack.generated, players: s.pack.list.length,
    without: s.pack.missing.map((m) => m.name),
  };
}

function levelSummary() {
  try {
    const dat = zlib.gunzipSync(fs.readFileSync(path.join(WORLD, 'level.dat')));
    const d = readNbt(dat).value.Data;
    return {
      name: String(d.LevelName ?? ''), version: String(d.Version?.Id ?? d.version?.Id ?? ''),
      dataVersion: Number(d.DataVersion ?? 0),
      spawn: [Number(d.SpawnX ?? 0), Number(d.SpawnY ?? 0), Number(d.SpawnZ ?? 0)],
      gameType: Number(d.GameType ?? -1), hardcore: Number(d.hardcore ?? 0), difficulty: String(d.difficulty ?? ''),
    };
  } catch (e) { return { error: String(e.message ?? e) }; }
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

const CT_MAGIC = 'DVDXB1  ';

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

function serveFile(res, req, file) {
  const p = path.resolve(file);
  if (!p.startsWith(path.resolve(process.cwd()))) return send(req, res, 404, 'outside repo', 'text/plain');
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
  if (p === '/voxels' || p === '/shells') {
    return `${p} ${q.get('dim') ?? '-'} ${q.get('cx0')},${q.get('cz0')} ${q.get('w')}x${q.get('h')}`;
  }
  if (p === '/lod') return `${p} ${q.get('dim') ?? '-'} cell=${q.get('cell')} ${q.get('rx')},${q.get('rz')}`;
  if (p === '/voxel' || p === '/shell') return `${p} ${q.get('dim') ?? '-'} ${q.get('cx')},${q.get('cz')}`;
  return p;
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
    // Where the time actually goes: a decode is 25 ms of work hidden behind a 0.1 ms file read, and
    // a regionOpen means the payload cache did not absorb the request.
    if (u.pathname === '/stats') {
      const byPath = {};
      for (const [p, e] of REQ) {
        byPath[p] = { n: e.n, ms: +e.ms.toFixed(0), max: +e.max.toFixed(0), slow: e.slow,
          kb: +(e.bytes / 1024).toFixed(0) };
      }
      send(req, res, 200, JSON.stringify({ ...svc.stats, packsOpen: svc.packs.size,
        inflight: INFLIGHT.size, byPath }), 'application/json');
      return;
    }
    if (u.pathname === '/skins/strip.json' || u.pathname === '/skins/strip.png') {
      const s = skinsNow();
      if (!s) return send(req, res, 404, '{"error":"no skin pack"}', 'application/json');
      if (u.pathname.endsWith('.png')) {
        return send(req, res, 200, stripPng(s.strip), 'image/png', { 'Cache-Control': 'no-cache' });
      }
      return send(req, res, 200, JSON.stringify(stripJson(s.strip, s.pack)), 'application/json; charset=utf-8');
    }
    if (u.pathname === '/meta') {
      return send(req, res, 200, JSON.stringify({
        world: WORLD, level: levelSummary(), dims: svc.dimList(),
        assets: { states: atlas.states.length, textures: atlas.textures.length, atlasSize: atlas.atlasSize, geometry: atlas.geometry },
        stats: svc.stats,
        packed: { shells: fs.existsSync(PACKS), lod: lodSummary, ledger: ledger.ready,
          skins: skinsSummary() },
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
    if (u.pathname.startsWith('/assets/')) return serveFile(res, req, path.join(ASSETS, u.pathname.slice(8)));
    // the skin manifest and the individual PNGs, for poking at; the page only asks for the strip
    if (u.pathname.startsWith('/skins/')) return serveFile(res, req, path.join(SKINS, u.pathname.slice(7)));
    if (u.pathname.startsWith('/shared/')) return serveFile(res, req, path.join('shared', u.pathname.slice(8)));
    // three is served straight out of node_modules; the build/ dir is self-contained (its
    // three.module.js imports ./three.core.js by relative path).
    if (u.pathname.startsWith('/vendor/')) return serveFile(res, req, path.join(VENDOR_DIR, u.pathname.slice(8)));
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
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
  // a mount should set, so this log answers "did my mount actually arrive?".
  const packHere = (d) => (d === 'none' || !fs.existsSync(d)) ? 0
    : fs.readdirSync(d).filter((f) => f !== '.keep' && !f.startsWith('.')).length;
  console.log(`shell packs: ${packHere(PACKS) ? `${PACKS} (${packHere(PACKS)} entries)` : `nothing at ${PACKS} — mount a pack (WD_PACKS) or run node server/bake-shells.mjs`}`);
  console.log(`lod tiles: ${lodSummary.tiles ? `${LODS} (${lodSummary.tiles} tiles, ${lodSummary.dims} dimensions)` : `nothing at ${LODS} — mount a pack (WD_LODS) or run node server/bake-lod.mjs`}`);
  console.log(`  ledger: ${packHere(LEDGER) ? `${LEDGER} (${packHere(LEDGER)} files)` : `nothing at ${LEDGER} — mount a pack (WD_LEDGER) or run npm run bake:ledger`}`);
  {
    const sk = skinsSummary();
    console.log(sk.available
      ? `   skins: ${SKINS} (${sk.players} players${sk.without.length ? `, without a skin: ${sk.without.join(' ')}` : ''})`
      : `   skins: ${sk.why}`);
  }
  console.log(`  world  ${WORLD}  (${svc.dims.size} dimensions)`);
  for (const d of svc.dimList()) {
    console.log(`  ${d.id.padEnd(24)} regions=${String(d.regions).padStart(4)} chunks<=${d.chunksUpperBound}` +
      ` x=${d.chunkExtent?.minX}..${d.chunkExtent?.maxX} z=${d.chunkExtent?.minZ}..${d.chunkExtent?.maxZ}`);
  }
  console.log(`  states ${atlas.states.length}  textures ${atlas.textures.length}`);
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
  let prev = { ...svc.stats };
  // A 1 s timer that only stamps the time is how the loop gets watched: if the callback lands late, the
  // loop was blocked, and by how much. That is the difference between "the server is slow" and "the
  // server is stuck", which is the question the 11/07 incident was about.
  let lastTick = Date.now(), lagMax = 0;
  setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - lastTick - 1000);
    lastTick = now;
  }, 1000).unref();
  setInterval(() => {
    const d = [];
    for (const [k, v] of Object.entries(svc.stats)) { if (v !== prev[k]) d.push(`${k}+${v - prev[k]}`); prev[k] = v; }
    let reqN = 0, slowN = 0;
    for (const e of REQ.values()) { reqN += e.n; slowN += e.slow; }
    // Name the stuck requests, not just that something is stuck: one line saying `/voxels ... 64x64 has
    // been running for 41 s` turns a bug hunt into a bug.
    const stuck = [...INFLIGHT.values()].filter((v) => performance.now() - v.since > 2000)
      .map((v) => `${v.tag} ${(Math.round((performance.now() - v.since) / 100) / 10)}s`);
    console.log(`hb ${Math.round((Date.now() - T0) / 1000)}s rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` +
      ` packs=${svc.packs.size} lagMax=${lagMax}ms reqs=${reqN}${slowN ? ` slow=${slowN}` : ''}` +
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
