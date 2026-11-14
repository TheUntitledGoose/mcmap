// The container contract: a Docker image and a compose stack that a person who has never seen this
// repo can deploy from Portainer. Nothing here runs docker (this box has no docker binary); what is
// checked is the thing that actually breaks silently - the paths and flag names the image promises,
// against the ones the server reads.
//
// Failure mode this prevents: a rename of `--packs`, or a pack directory moving, leaves the
// Dockerfile copying a directory that no longer exists, or setting WD_PACKS to a path nothing reads.
// `docker build` still succeeds (COPY of a missing path is an error, but a *stale* path is not), the
// container starts, and the far world is simply gone - served as holes, with no error anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { envArgs } from '../shared/envargs.mjs';
import { WORLDD_FLAGS } from '../server/worldd-flags.mjs';
import { needPacks, needServer } from './needs.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const DOCKERFILE = read('Dockerfile');
const IGNORE = read('.dockerignore');
const COMPOSE = read('compose.yaml');
const SERVER = read('server/worldd.mjs');

test('the flag list matches the flags the server reads', () => {
  const used = new Set();
  for (const m of SERVER.matchAll(/\b(?:arg|num)\('([a-z][a-z0-9-]*)'/g)) used.add(m[1]);
  const listed = new Set(WORLDD_FLAGS);
  assert.deepEqual([...used].filter((f) => !listed.has(f)), [],
    'worldd reads a flag that is not in WORLDD_FLAGS, so WD_* cannot set it');
  assert.deepEqual([...listed].filter((f) => !used.has(f)), [],
    'WORLDD_FLAGS advertises a flag worldd no longer reads');
});

test('WD_* variables become exactly the flags the server reads, and only those', () => {
  const args = envArgs({
    WD_WORLD: '/data/DarkRPG/world',
    WD_CACHE_MAX_GB: '6',
    WD_PORT: '8765',
    WD_LEDGER: 'none',
    WD_CACHE: '',            // empty means "not set", not a flag that eats the next argument
    WD_NOT_A_FLAG: 'x',      // well formed but unknown: passed through so the boot can refuse it
    WD_9LIVES: 'x',          // not a flag name at all: dropped, nothing can refuse it meaningfully
  });
  assert.deepEqual(args, [
    '--world', '/data/DarkRPG/world',
    '--cache-max-gb', '6',
    '--port', '8765',
    '--ledger', 'none',
    '--not-a-flag', 'x',
  ]);
  // Anything that does reach the command line is checked against the real flag list at boot; a name
  // that is not there exits 2 (asserted below on a real spawn) rather than being ignored.
  for (const a of args.filter((x) => x.startsWith('--'))) {
    if (a === '--not-a-flag') continue;
    assert.ok(WORLDD_FLAGS.includes(a.slice(2)), `${a} is not a real flag`);
  }
});

test('the image ships the code and the packs the server refuses to run without', { skip: needPacks() }, () => {
  for (const dir of ['server/', 'shared/', 'tools/', 'web/']) {
    assert.ok(DOCKERFILE.includes(`COPY ${dir}`), `Dockerfile does not copy ${dir}`);
  }
  // worldd exits 1 when build/assets/atlas.json is missing; the packs are what the far layers read.
  for (const pack of ['build/assets/', 'build/shells/', 'build/lods/', 'build/ledger/']) {
    assert.ok(DOCKERFILE.includes(`COPY ${pack}`), `Dockerfile does not copy ${pack}`);
    assert.ok(fs.existsSync(pack), `${pack} does not exist in the repo - bake it before building`);
  }
  assert.ok(/CMD \["node", "server\/worldd\.mjs"\]/.test(DOCKERFILE), 'CMD does not run worldd');
});

test('the build context excludes the save, the cache and git history', () => {
  // These three are gigabytes each. The context is tar'ed before the first RUN, so including any of
  // them makes every build take minutes and a full disk.
  for (const entry of ['DarkRPG/', 'build/cache/', '.git/']) {
    assert.ok(IGNORE.split('\n').some((l) => l.trim() === entry), `.dockerignore is missing ${entry}`);
  }
  assert.ok(!/!\s*(DarkRPG|build\/cache|\.git)/.test(IGNORE),
    'a negation puts a huge excluded tree back into the context');
});

test('the stack mounts the save read-only and names the same paths the image defaults to', () => {
  assert.ok(/read_only:\s*true/.test(COMPOSE), 'the save mount is writable; the renderer never writes a world');
  assert.ok(/WD_WORLD:\s*\/data\/DarkRPG\/world/.test(COMPOSE), 'WD_WORLD does not match the mount target');
  assert.ok(/target:\s*\/data\/DarkRPG\b/.test(COMPOSE), 'the save is not mounted where WD_WORLD points');
  assert.ok(/WD_CACHE:\s*\/data\/cache/.test(COMPOSE), 'WD_CACHE does not match the cache volume');
  assert.ok(/mcmap-cache:\/data\/cache/.test(COMPOSE), 'the cache volume is not mounted at WD_CACHE');
  // Every WD_* in the stack must be a real flag, or it silently does nothing.
  const envNames = [...COMPOSE.matchAll(/^\s*(WD_[A-Z0-9_]+):/gm)].map((m) => m[1]);
  assert.ok(envNames.length >= 6, 'the stack sets almost nothing; is this the right file?');
  for (const n of envNames) {
    const flag = n.slice(3).toLowerCase().replace(/_/g, '-');
    assert.ok(WORLDD_FLAGS.includes(flag), `${n} is not a worldd flag (${flag})`);
  }
  // The health check must outlast the boot cache sweep, which over a large cache takes minutes.
  const sp = /start_period:\s*(\d+)s/.exec(COMPOSE);
  assert.ok(sp && Number(sp[1]) >= 120, 'healthcheck start_period is shorter than the boot sweep can take');
});

test('the health checks are spelled the way BOTH parsers require', () => {
  // `docker compose` accepts a bare exec array for healthcheck.test. Portainer's loader does not, and
  // it fails the entire stack deploy, not just the check:
  //   healthcheck.test must start either by "CMD", "CMD-SHELL" or "NONE"
  const t = /test:\s*\[([^\]]*)\]/.exec(COMPOSE);
  assert.ok(t, 'the stack has no healthcheck.test array to inspect');
  const first = t[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
  assert.ok(['CMD', 'CMD-SHELL', 'NONE'].includes(first),
    `healthcheck.test starts with "${first}"; Portainer needs CMD, CMD-SHELL or NONE as the first word`);
  // The Dockerfile's own check has the opposite trap: HEALTHCHECK wants the CMD instruction, and the
  // exec form must be the array after it (a shell string there silently runs /bin/sh -c in front).
  assert.ok(/HEALTHCHECK[\s\S]{0,240}?\bCMD \["node"/.test(DOCKERFILE),
    'Dockerfile HEALTHCHECK is not the CMD ["node", ...] exec form');
});

test('the health check route exists in the server', () => {
  // A health check pointed at a route that does not exist marks a healthy container unhealthy.
  assert.ok(/['"]\/stats['"]/.test(SERVER), 'the /stats route the image health-checks is gone');
});

test('worldd boots from the environment with no command line, and refuses a WD_* that is not a flag',
  { skip: needServer() }, async () => {
  const port = 8830 + (process.pid % 60);
  const env = {
    ...process.env,
    WD_PORT: String(port),
    WD_HOST: '127.0.0.1',
    WD_CACHE: 'none',
    WD_HEARTBEAT: '0',
  };
  const child = spawn(process.execPath, ['server/worldd.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  try {
    let meta = null;
    for (let i = 0; i < 120 && !meta; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/meta`);
        if (r.ok) meta = await r.json();
      } catch { /* not listening yet */ }
      if (!meta) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(meta, `no /meta on WD_PORT=${port}:\n${log}`);
    assert.ok(meta.dims.length, 'no dimensions: the env world path was not read');
  } finally {
    child.kill('SIGKILL');
  }

  const bad = spawn(process.execPath, ['server/worldd.mjs'],
    { env: { ...process.env, WD_NOT_A_FLAG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let code = null;
  bad.stderr.on('data', (b) => { err += b; });
  bad.on('exit', (c) => { code = c; });
  await new Promise((r) => {
    const iv = setInterval(() => { if (code !== null) { clearInterval(iv); r(); } }, 50);
    setTimeout(() => { clearInterval(iv); r(); }, 5000);
  });
  assert.equal(code, 2, 'an unknown WD_* must exit non-zero, not be ignored');
  assert.match(err, /WD_NOT_A_FLAG/, 'the refusal does not name the offending variable');
});
