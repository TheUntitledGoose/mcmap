#!/usr/bin/env node
// Run the image's contract without docker.
//
//   node tools/sim-container.mjs [--world DarkRPG/world] [--stage build/sim-container]
//                                [--port 8899] [--clean]   (--clean removes the ~224 MB staged tree at the end)
//
// This box has no docker binary, so the Dockerfile cannot be executed here. What *can* be checked is
// the part that actually fails in the field: a fresh directory containing exactly what the image
// COPYs, started from that directory as its only cwd, with the image's environment variables and no
// command line. Anything the server reaches for outside that set - a relative path that only works
// from the repo root, a pack that was never copied, a WD_* that is not a flag - shows up as a failed
// route here instead of as a mysterious hole in the far world three days later.
//
// What it does NOT check: file ownership (USER node), volume mounts, the healthcheck. Docker owns
// those; tools/container-contract.test.mjs asserts them from the text.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const ROOT = path.resolve('.');
const WORLD = path.resolve(arg('world', 'DarkRPG/world'));
const STAGE = path.resolve(arg('stage', 'build/sim-container'));
const PORT = +arg('port', 8899);

// Exactly the COPY lines of the Dockerfile, plus the vendored runtime it serves.
const COPY_DIRS = ['server', 'shared', 'tools', 'web'];
const COPY_PACKS = ['build/assets', 'build/shells', 'build/lods', 'build/ledger', 'build/skins'];
const COPY_FILES = ['package.json', 'package-lock.json', 'Dockerfile', 'compose.yaml', '.dockerignore'];

const say = (m) => console.log(m);
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); return cond; };

say(`staging ${STAGE} from ${ROOT}`);
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
let bytes = 0;
const size = (p) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) return [...fs.readdirSync(p)].reduce((a, f) => a + size(path.join(p, f)), 0);
  return st.size;
};
for (const d of [...COPY_DIRS, ...COPY_PACKS]) {
  const s = path.join(ROOT, d);
  if (!check(fs.existsSync(s), `COPY ${d}/: not in the repo, so the image build stops here`)) continue;
  fs.cpSync(s, path.join(STAGE, d), { recursive: true });
  bytes += size(path.join(STAGE, d));
}
for (const f of COPY_FILES) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(STAGE, f));
}
// npm ci --omit=dev in the image; here just the runtime package the server serves.
fs.cpSync(path.join(ROOT, 'node_modules', 'three'), path.join(STAGE, 'node_modules', 'three'), { recursive: true });
bytes += size(path.join(STAGE, 'node_modules'));
say(`staged ${(bytes / 1e6).toFixed(0)} MB (the image payload, minus node's own modules)`);

// The image's own environment (Dockerfile ENV), with the mount replaced by this machine's save.
// Any WD_* this shell happens to have is dropped first: the point is to boot on the image's defaults.
const CACHE = path.join(STAGE, 'data/cache');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WD_')));
Object.assign(env, {
  WD_WORLD: WORLD,
  WD_CACHE: CACHE,
  WD_CACHE_MAX_GB: '1',
  WD_HOST: '127.0.0.1',
  WD_PORT: String(PORT),
  WD_SLOW_MS: '400',
  WD_HEARTBEAT: '0',
});

// The port has to be this run's port. An earlier sim that never exited keeps answering, the new child dies
// on EADDRINUSE, and every probe below then reports on SOME OTHER tree - which is how a staged run once
// "proved" /skins/strip.json was a 404 while the staged tree served it fine.
const base = `http://127.0.0.1:${PORT}`;
try {
  const r = await fetch(`${base}/stats`);
  throw new Error(`port ${PORT} is already answered by something else (status ${r.status}): kill that process,`
    + ` or run with --port <free>`);
} catch (e) {
  if (!(e.cause && /ECONNREFUSED|EADDRNOTAVAIL|ENOTFOUND/.test(String(e.cause.code || e.cause.message)))) {
    if (e.message.startsWith(`port ${PORT}`)) throw e;
    // anything else (a refused connection is the wanted answer) is fine
  }
}

say(`boot: node server/worldd.mjs (no flags), cwd=${STAGE}`);
const child = spawn(process.execPath, ['server/worldd.mjs'], { cwd: STAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });

async function waitReady(ms) {
  for (let t = 0; t < ms; t += 250) {
    try { const r = await fetch(`${base}/meta`); if (r.ok) return await r.json(); } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

try {
  const meta = await waitReady(20000);
  if (!check(meta, `server did not come up from the staged tree:\n${log}`)) throw new Error('boot');
  say(`/meta: ${meta.dims.length} dimensions: ${meta.dims.map((d) => d.id).join(', ')}`);

  const probes = [
    ['/', (r, x) => `${r.status} ${x.bytes} B, app: ${/canvas/.test(x.text || '')}`],
    ['/stats', (r, x) => `${r.status} ${x.text.slice(0, 90)}`],
    ['/vendor/three.module.js', (r, x) => `${r.status} ${x.bytes} B`],
    ['/assets/atlas.json', (r, x) => `${r.status} ${x.bytes} B`],
    ['/ledger/meta', (r, x) => `${r.status} ${x.text.slice(0, 60)}`],
    ['/shells?dim=minecraft:overworld&cx0=0&cz0=0&w=2&h=2', (r, x) => `${r.status} ${x.bytes} B ${r.headers.get('content-type')}`],
    ['/lodindex?dim=minecraft:overworld', (r, x) => `${r.status} ${x.text.slice(0, 70)}`],
    ['/regions?dim=minecraft:overworld', (r, x) => `${r.status} ${x.text.slice(0, 70)}`],
    ['/overview?dim=minecraft:overworld', (r, x) => `${r.status} ${x.bytes} B`],
    ['/voxels?dim=minecraft:overworld&cx0=0&cz0=0&w=1&h=1', (r, x) => `${r.status} ${x.bytes} B ${r.headers.get('content-type')}`],
  ];
  for (const [route, how] of probes) {
    let r, x = { text: '', bytes: 0 };
    try {
      r = await fetch(base + route);
      const ct = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      x = { bytes: buf.length, text: /json|html|javascript|text/.test(ct) ? buf.toString('utf8') : '' };
    } catch (e) { fails.push(`${route}: ${e.message}`); continue; }
    const verdict = how(r, x);
    check(r.status < 400, `${route} -> ${r.status}`);
    say(`${route.padEnd(52)} ${verdict}`);
  }

  // The save mount: a detail request must decode real chunks, not report a missing world.
  const vox = await fetch(`${base}/voxels?dim=minecraft:overworld&cx0=0&cz0=0&w=1&h=1`);
  check(vox.status === 200 && (await vox.arrayBuffer()).byteLength > 64,
    '/voxels did not return payload: is the save readable from the staged cwd?');

  // Skins are the optional pack, so both answers are correct - but each has to be the RIGHT one, and the
  // strip has to arrive as one PNG the page can upload, not as six files it has to stitch itself.
  const haveSkins = fs.existsSync(path.join(STAGE, 'build/skins/manifest.json'));
  const sj = await fetch(`${base}/skins/strip.json`);
  const sjBuf = Buffer.from(await sj.arrayBuffer());
  if (haveSkins) {
    check(sj.status === 200, `/skins/strip.json -> ${sj.status} although build/skins/manifest.json is staged`);
    const j = JSON.parse(sjBuf.toString('utf8'));
    check(j.columns >= 2 && j.white === j.columns - 1, `strip.json says columns=${j.columns} white=${j.white}`);
    const sp = await fetch(`${base}/skins/strip.png`);
    const spBuf = Buffer.from(await sp.arrayBuffer());
    const png = spBuf.length > 8 && spBuf.readUInt32BE(0) === 0x89504e47;
    check(sp.status === 200 && png, `/skins/strip.png -> ${sp.status}, PNG signature: ${png}`);
    const w = spBuf.readUInt32BE(16), h = spBuf.readUInt32BE(20);
    check(w === j.columns * j.cell && h === j.cell, `strip PNG is ${w}x${h}, expected ${j.columns * j.cell}x${j.cell}`);
    say(`/skins/strip.{json,png}   ${j.columns} columns of ${j.cell}px, white at ${j.white}, PNG ${w}x${h}, `
      + `no skin for ${(j.missing || []).map((m) => m.name).join(' ') || 'nobody'}`);
  } else {
    check(sj.status === 404, `/skins/strip.json -> ${sj.status} with no pack staged; expected a 404 that says so`);
    say('/skins/strip.json        no pack staged (optional): the cast stands tinted');
  }

  // Unknown WD_* must be refused, and that refusal must not look like a successful boot.
  const bad = spawn(process.execPath, ['server/worldd.mjs'], { cwd: STAGE, env: { ...env, WD_NOT_A_FLAG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', code = null;
  bad.stderr.on('data', (b) => { err += b; });
  bad.on('exit', (c) => { code = c; });
  await new Promise((r) => { const iv = setInterval(() => { if (code !== null) { clearInterval(iv); r(); } }, 50); setTimeout(() => { clearInterval(iv); r(); }, 4000); });
  check(code === 2, `WD_NOT_A_FLAG exited ${code}, expected 2`);
  check(/WD_NOT_A_FLAG/.test(err), 'the refusal did not name the variable');
  say(`WD_NOT_A_FLAG -> exit ${code}: ${err.split('\n')[0] || '(no stderr)'}`);

  // A second boot with the cache the first one filled: the sweep must not eat the world's payloads.
  const files = (() => { try { return fs.readdirSync(path.join(CACHE)).length; } catch { return 0; } })();
  say(`cache written under the staged tree: ${files} top-level entries`);
} finally {
  child.kill('SIGKILL');
}

if (fails.length) {
  console.error('\nFAILED:');
  for (const f of fails) console.error('  - ' + f);
  console.error('\nlog:\n' + log.slice(-2000));
  process.exit(1);
}
say(`\nOK: the staged tree serves the app, the packs and the save with the image's environment alone.`);
if (process.argv.includes("--clean")) {
  // Windows can still be holding a handle in the tree a beat after the child exits (a log file, an index
  // pass). An OK run must not end in a stack trace: say where the tree is and let the next run sweep it.
  let gone = false;
  for (let i = 0; i < 3 && !gone; i++) {
    try { fs.rmSync(STAGE, { recursive: true, force: true }); gone = true; }
    catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); }
  }
  say(gone ? 'staged tree removed (--clean)' : `--clean could not remove ${STAGE} (something still holds it); delete it later`);
}
else say(`staged tree left at ${STAGE} (delete it when done, or pass --clean)`);
