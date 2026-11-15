// /skins: one description and one texture for the whole cast, and an honest 404 when the pack is absent.
// Appended to the endpoint suite's own server so the routes are checked over HTTP, not by calling the
// module: what breaks in deployment is usually the route, the content type, or a path that meant to be a
// flag and was not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './free-port.mjs';

// A port from the OS, not a slice of 8880-8969: those slices overlap other suites and a collision reads
// as a failing server rather than a taken port. See tests/free-port.mjs.
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function boot(args, env = {}) {
  const child = spawn(process.execPath, ['server/worldd.mjs', '--port', String(PORT), '--cache', 'none',
    '--heartbeat', '0', '--host', '127.0.0.1', ...args],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  return { child, get log() { return log; } };
}

async function waitUp(srv) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/meta`); if (r.ok) return await r.json(); } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worldd did not come up:\n${srv.log}`);
}

test('the skin strip answers as one PNG plus a description that says what each column is', async () => {
  const srv = boot([]);
  try {
    const meta = await waitUp(srv);
    if (!meta.packed.skins || !meta.packed.skins.available) {
      // Legal, and the page has to cope with it: no pack means the cast stands tinted. Say which case ran.
      const r = await fetch(`${BASE}/skins/strip.json`);
      assert.equal(r.status, 404, 'no pack, but the route answered anyway');
      return;
    }
    const j = await (await fetch(`${BASE}/skins/strip.json`)).json();
    assert.ok(j.columns >= 2, 'at least one player and the white fallback column');
    assert.equal(j.white, j.columns - 1, 'the last column belongs to nobody');
    assert.equal(j.cell, 64, 'a skin is 64px');
    assert.ok(j.cells.every((c, i) => c.column === i), 'columns are numbered, not implied');
    assert.ok(Array.isArray(j.missing), 'who has no skin, and why');
    const r = await fetch(`${BASE}/skins/strip.png`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/png/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 8)], PNG, 'the strip has to be a PNG the browser can decode');
    // IHDR width/height, read straight off the file: the page sizes its UVs from the JSON, and a PNG that
    // disagrees with the JSON would put one player's face on another's body.
    assert.equal(buf.readUInt32BE(16), j.columns * j.cell, 'strip PNG width vs the description');
    assert.equal(buf.readUInt32BE(20), j.cell, 'strip PNG height vs the description');
  } finally { srv.child.kill('SIGKILL'); }
});

test('a skins pack that is not there is reported, not invented', async () => {
  const srv = boot(['--skins', 'build/nope-not-here']);
  try {
    const meta = await waitUp(srv);
    assert.equal(meta.packed.skins.available, false);
    assert.match(meta.packed.skins.why, /no pack|manifest/);
    const r = await fetch(`${BASE}/skins/strip.json`);
    assert.equal(r.status, 404);
  } finally { srv.child.kill('SIGKILL'); }
});

test('--skins none disables the layer without an error page', async () => {
  const srv = boot(['--skins', 'none']);
  try {
    const meta = await waitUp(srv);
    assert.equal(meta.packed.skins.available, false);
    assert.match(meta.packed.skins.why, /disabled/);
  } finally { srv.child.kill('SIGKILL'); }
});

test('WD_SKINS reaches the same flag in a container', async () => {
  const srv = boot([], { WD_SKINS: 'build/nope-not-here' });
  try {
    const meta = await waitUp(srv);
    assert.match(meta.packed.skins.why, /build\/nope-not-here/, 'the variable did not reach the flag');
  } finally { srv.child.kill('SIGKILL'); }
});
