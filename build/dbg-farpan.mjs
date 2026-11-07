// Reproduce "pan far out and back" without a browser: drive the same request shapes the stores make at
// whole-world framing (payload in 6x6 tiles, shell coverage in 64x64 blocks) along a line that crosses
// both filled and empty ground, and watch what the server does with it. The question is not "is it slow"
// but "does a request still get answered while the far pan is in flight", so a /meta probe runs through
// the load and reports its own latency.
//
//   node build/dbg-farpan.mjs                  # the pan the 11/07 incident could not survive
//   node build/dbg-farpan.mjs --steps 40 --payload-r 0 --shell-r 128
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const num = (k, d) => { const v = Number(arg(k, d)); return Number.isFinite(v) ? v : d; };
const PORT = num('port', 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const DIM = arg('dim', 'minecraft:overworld');
const STEPS = num('steps', 60);
const PR = num('payload-r', 36);        // chunk radius of the detail/payload skin
const SR = num('shell-r', 192);         // chunk radius of shell coverage (64x64 blocks)
const CONC = num('concurrency', 3);     // per store, as web/js/store.js defaults
const TILE = 6;                         // payload tile side, as storeOpts()

// A line from the user's pulled-back spot west into the sparse corner and back: (-372,892) is roughly
// x=-5952 z=14272, and the run then heads north-west across regions that exist but are barely written.
const FROM = [Math.round(num('cx', -372)), Math.round(num('cz', 892))];
const WAY = [[-40, -6], [-24, -28], [8, -40], [40, -14], [16, 34]];

function line(steps) {
  const pts = [FROM];
  let cur = FROM;
  for (const [dx, dz] of WAY) { cur = [cur[0] + dx, cur[1] + dz]; pts.push(cur); }
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const n = 8;
    for (let k = 0; k < n; k++) out.push([Math.round(ax + ((bx - ax) * k) / n), Math.round(az + ((bz - az) * k) / n)]);
  }
  out.push(...pts.at(-1) && [pts.at(-1)]);
  while (out.length < steps) out.push(pts.at(-1));
  return out.slice(0, steps);
}

const statsOf = async () => JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/stats`)).text());
const times = [];
async function get(url) {
  const t0 = performance.now();
  let bytes = 0, status = 'ok';
  try {
    const r = await fetch(url);
    bytes = (await r.arrayBuffer()).byteLength;
    if (!r.ok) status = 'http' + r.status;
  } catch (e) { status = 'err'; }
  const ms = performance.now() - t0;
  times.push({ ms, bytes, status, url });
  return { ms, bytes };
}

/** A queue with bounded in-flight, like the stores: what a pan actually looks like on the wire. */
async function pump(urls, conc) {
  let i = 0;
  const worker = async () => { while (i < urls.length) await get(urls[i++]); };
  await Promise.all(Array.from({ length: conc }, worker));
}

const before = await statsOf();
const seen = new Set();
const t0 = performance.now();
let probes = 0, probeMs = [], centers = 0;
const probeTimer = setInterval(async () => {
  const p0 = performance.now();
  try { await (await fetch(`http://127.0.0.1:${PORT}/meta`)).text(); probeMs.push(+(performance.now() - p0).toFixed(0)); probes++; } catch { }
}, 2000);

for (const [cx, cz] of line(STEPS)) {
  centers++;
  const urls = [];
  // payload: every 6x6 tile whose centre box the skin covers, deduped across the whole pan
  for (const [tx, ty] of tilesFor(cx, cz, PR, TILE)) {
    const k = `v${tx},${ty}`;
    if (!seen.has(k)) { seen.add(k); urls.push(`/voxels?dim=${DIM}&cx0=${tx}&cz0=${ty}&w=${TILE}&h=${TILE}`); }
  }
  // shell coverage: 64x64 blocks around the same centre
  for (const [tx, ty] of tilesFor(cx, cz, SR, 64)) {
    const k = `s${tx},${ty}`;
    if (!seen.has(k)) { seen.add(k); urls.push(`/shells?dim=${DIM}&cx0=${tx}&cz0=${ty}&w=64&h=64`); }
  }
  await pump(urls.map((u) => BASE + u), CONC);
}
clearInterval(probeTimer);
const after = await statsOf();
const wall = ((performance.now() - t0) / 1000).toFixed(1);

/** The tile grid a store would ask for, aligned to multiples of `side` exactly like its tkey. */
function tilesFor(cx, cz, radius, side) {
  const x0 = Math.floor((cx - radius) / side) * side, x1 = cx + radius;
  const z0 = Math.floor((cz - radius) / side) * side, z1 = cz + radius;
  const out = [];
  for (let tz = z0; tz <= z1; tz += side) for (let tx = x0; tx <= x1; tx += side) out.push([tx, tz]);
  return out;
}

const ok = times.filter((t) => t.status === 'ok');
const slow = [...times].sort((a, b) => b.ms - a.ms).slice(0, 6);
const pct = (q) => +([...times].sort((a, b) => a.ms - b.ms)[Math.min(times.length - 1, Math.floor(times.length * q))].ms.toFixed(0));
const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0);
console.log(JSON.stringify({
  seconds: +wall, centers, requests: times.length, distinctTiles: seen.size,
  ms: { median: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: +Math.max(...times.map((t) => t.ms)).toFixed(0) },
  worst: slow.map((t) => ({ ms: +t.ms.toFixed(0), bytes: t.bytes, url: t.url.slice(0, 64) })),
  emptyResponses: times.filter((t) => t.bytes === 0 || t.status !== 'ok').length,
  // The probe once used `cx=` where the server reads `cx0=`; NaN coordinates came back as chunk
  // (0,0) and every tile looked like data. Tiny responses are the honest way to see the difference.
  tinyResponses: times.filter((t) => t.bytes < 1024).length,
  wireMB: +(times.reduce((a, t) => a + t.bytes, 0) / 1e6).toFixed(1),
  byPathBytes: Object.fromEntries(Object.entries(after.byPath ?? {}).map(([p, e]) => [p, { n: e.n, kb: e.kb, max: e.max }])),
  aliveProbe: { probes, medianMs: probeMs.sort((a, b) => a - b)[probeMs.length >> 1] ?? null, maxMs: Math.max(...probeMs) },
  server: Object.fromEntries(['cacheHits', 'decodes', 'empty', 'holes', 'regionOpens', 'cacheWrites', 'cachePruned', 'sweeps',
    'missing', 'missHits', 'coverageSkips', 'coverageSlots'].map((k) => [k, delta(k)])),
  inflightNow: after.inflight,
}, null, 1));
