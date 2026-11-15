// The wire contract: coordinates that are not numbers are a 400, and /regions tells the browser
// which region cells exist.
//
// Why the 400 exists: `+q.get('cx0')` is 0 when the parameter is missing and NaN when it is spelled
// wrong, and `NaN >> 5` is 0 - so `/voxels?...&cx=-366&cz=892` answered chunk (0,0) with a 200 and
// 4.5 MB of plausible payload. A whole measurement ("168 MB per pan") was built on that typo before
// the tiny responses were noticed. A wrong parameter name must fail, not be answered with data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fromWire, makeReader } from '../shared/regionbits.mjs';
import { decodeTimeline, readPack } from '../shared/ledger-pack.mjs';
import { pngSize } from '../shared/embed.mjs';
import { BATCH_MAGIC } from '../shared/chunk-format.mjs';
import { freePort } from './free-port.mjs';

// A port from the OS, not a slice of 8790-8879: the slices suites used to take overlap each other, and a
// collision looks like a server that will not start. See tests/free-port.mjs.
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server/worldd.mjs', '--port', String(PORT), '--cache', 'none',
  '--heartbeat', '0', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });

const get = async (p) => {
  const r = await fetch(BASE + p);
  const buf = Buffer.from(await r.arrayBuffer());
  return { code: r.status, buf, text: buf.toString('utf8') };
};

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

test('the server boots on a test port and answers /meta', async () => {
  const meta = await waitReady();
  assert.ok(meta.dims.some((d) => d.id === 'minecraft:overworld'));
});

test('a missing or misspelled coordinate is a 400, not somebody else\'s chunk', async () => {
  // The exact typo that made a far-pan probe lie: cx/cz instead of cx0/cz0.
  const typo = await get('/voxels?dim=minecraft:overworld&cx=-366&cz=892&w=6&h=6');
  assert.equal(typo.code, 400, `expected 400, got ${typo.code} and ${typo.buf.length} bytes`);
  assert.match(typo.text, /cx0/);
  const junk = await get('/voxels?dim=minecraft:overworld&cx0=-366&cz0=north&w=6&h=6');
  assert.equal(junk.code, 400);
  assert.match(junk.text, /cz0/);
  const shells = await get('/shells?dim=minecraft:overworld&w=64&h=64');
  assert.equal(shells.code, 400, 'a block with no origin cannot default to (0,0) either');
  const one = await get('/voxel?dim=minecraft:overworld');
  assert.equal(one.code, 400);
});

test('a correct block still answers, and /regions describes the save', async () => {
  const ok = await get('/voxels?dim=minecraft:overworld&cx0=-20&cz0=-30&w=3&h=3');
  assert.equal(ok.code, 200);
  assert.equal(ok.buf.subarray(0, 8).toString('latin1'), BATCH_MAGIC, 'batch magic, i.e. real payload');
  assert.notEqual(ok.buf.readUInt32LE(8), 0, 'and it names the state table those payload ids number against');
  const meta = JSON.parse((await get('/meta')).text);
  const dim = meta.dims.find((d) => d.id === 'minecraft:overworld');
  const wire = JSON.parse((await get('/regions?dim=minecraft:overworld')).text);
  assert.equal(wire.cells, dim.regions, 'the wire coverage matches the listing /meta reports');
  const r = makeReader(fromWire(wire));
  assert.equal(r.count, dim.regions);
  const e = dim.chunkExtent;
  assert.ok(r.hasAny(e.minX, e.minZ, e.maxX - e.minX + 1, e.maxZ - e.minZ + 1));
  assert.ok(!r.hasAny(e.minX - 32 * 4, e.minZ, 32, 32), 'outside the save reads as empty');
  assert.ok(meta.coverage?.ttlMs > 0, 'and the server says how fresh the answer is');
});

test('an unknown dimension is a 404 on /regions, not an empty grid', async () => {
  const r = await get('/regions?dim=not:a:dimension');
  assert.equal(r.code, 404);
});

test('the ledger answers cells and timeline as two sizes, and both decode', async () => {
  const cells = await get('/ledger/cells?dim=minecraft:overworld');
  assert.equal(cells.code, 200);
  assert.equal(readPack(cells.buf).tlBytes, null,
    'the heat layer bytes declare no timeline, so a viewer cannot read past them by accident');

  const tl = await get('/ledger/timeline?dim=minecraft:overworld');
  assert.equal(tl.code, 200);
  const TL = decodeTimeline(tl.buf);
  assert.equal(TL.count, 351531, 'the whole overworld history is addressable from this one response');
  for (let i = 1; i < TL.count; i++) {
    if (TL.sec[i] < TL.sec[i - 1]) assert.fail(`row ${i} went back in time on the wire`);
  }
  const meta = JSON.parse((await get('/ledger/meta')).text);
  const dim = meta.dims.find((d) => d.dimKey === 'region');
  assert.equal(dim.rows, TL.count, 'and it agrees with what /ledger/meta claims for that dimension');

  // A dimension with no baked pack has no timeline. graveyard:past is the real case in this save: the
  // ledger knows the world, the copied save has no region folder for it.
  assert.equal((await get('/ledger/timeline?dim=not:a:dimension')).code, 404);
});

// The click path. `/ledger/rows` used to walk a chunk's rows in pack order and stop at `limit`, so a click
// on a late row in a busy chunk produced "no ledger row touches -54, 82, -127" about a chunk holding 3,280
// of them. That sentence was an artefact of the query, and it looked like a fact about the log.
test('a click query with near= answers the voxel it was aimed at', async () => {
  const busy = JSON.parse((await get('/ledger/rows?dim=minecraft:overworld&cx=-4&cz=-8&limit=200')).text);
  assert.ok(Array.isArray(busy.rows), 'the rows answer is JSON with a rows array');
  const last = busy.rows[busy.rows.length - 1];
  assert.ok(busy.total > 400, `this test wants a genuinely busy chunk, and -4,-8 holds ${busy.total}`);

  const aimed = JSON.parse((await get(`/ledger/rows?dim=minecraft:overworld&cx=-4&cz=-8&limit=1&near=${last.x},${last.y},${last.z}`)).text);
  assert.deepEqual([aimed.rows[0].x, aimed.rows[0].y, aimed.rows[0].z], [last.x, last.y, last.z],
    'the voxel that was aimed at comes back first, even 3,000 rows into the chunk');
  assert.ok(aimed.nearAt >= 1, 'and the answer counts the rows that sit exactly on it');
  assert.equal(aimed.scanned, busy.total, 'every row of the chunk was looked at');
  assert.equal(aimed.total, busy.total, 'the chunk total is unchanged by asking near');

  const plain = JSON.parse((await get('/ledger/rows?dim=minecraft:overworld&cx=-4&cz=-8&limit=5')).text);
  assert.equal(plain.nearAt, null, 'a query that named no voxel claims no "exactly here"');

  // A malformed near is a 400, not a silently dropped parameter: dropping it is what produced the
  // confident wrong sentence above.
  for (const bad of ['near=-54,82', 'near=-54,82,-127,9', 'near=x,y,z', 'near=']) {
    const r = await get(`/ledger/rows?dim=minecraft:overworld&cx=-4&cz=-8&limit=5&${bad}`);
    assert.equal(r.code, 400, `${bad} answered ${r.code}: ${r.text.slice(0, 80)}`);
    assert.match(r.text, /near/);
  }
});

test('the HTML a chat bot fetches carries its own card, absolute to the address it used', async () => {
  // Bots do not run the page, and they do not resolve relative URLs against anything: the tags have to
  // be in the bytes, and the picture has to be a URL this server answers. Behind a proxy, the forwarded
  // pair is the only thing that knows the public name.
  const r = await fetch(`${BASE}/?dim=minecraft%3Athe_nether`, {
    headers: { 'X-Forwarded-Host': 'map.example.com', 'X-Forwarded-Proto': 'https, http' },
  });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta property="og:image" content="https:\/\/map\.example\.com\/embed\.png">/,
    'a relative image URL is a card with no picture');
  assert.match(html, /<meta property="og:url" content="https:\/\/map\.example\.com\/\?dim=minecraft%3Athe_nether">/,
    'the framing in the URL survives into the link, so the card links back to the view it shows');
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  // and the declared size must be the size of the picture actually on the wire: the deployment may have
  // put its own screenshot at build/embed.png, and a wrong size in the tag crops the card wrong
  const w = +html.match(/og:image:width" content="(\d+)"/)?.[1];
  const h = +html.match(/og:image:height" content="(\d+)"/)?.[1];
  const img = await fetch(`${BASE}/embed.png`);
  assert.equal(img.status, 200, 'the card names a picture this server does not have');
  assert.equal(img.headers.get('content-type'), 'image/png');
  const real = pngSize(Buffer.from(await img.arrayBuffer()));
  assert.ok(real, 'the embed picture is not a PNG');
  assert.deepEqual({ w, h }, real, `the tags say ${w}x${h}, the file is ${real.w}x${real.h}`);
});

test('the log stays quiet enough to read', () => {
  // The heartbeat and slow-request log are the point of the instrumentation; a boot this short
  // should not have produced any of it.
  assert.doesNotMatch(log, /stuck|EADDRINUSE/);
});

test.done?.();
after(() => { try { child.kill(); } catch { } });
