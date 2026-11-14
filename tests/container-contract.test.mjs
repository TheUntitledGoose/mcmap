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
import os from 'node:os';
import path from 'node:path';
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
  // ... and the excludes must stay anchored at the context root: `build/*.json` cannot cross a slash, so
  // build/assets/atlas.json still arrives. A `build/**` line would quietly strip the packs down to their
  // keep files, and the container would then boot reporting packs it never got.
  assert.ok(!/^build\/(\*\*|\*\/\*)/m.test(IGNORE),
    '.dockerignore reaches into subdirectories of build/ - that is where the packs live');
  for (const pack of ['assets', 'shells', 'lods', 'ledger', 'skins']) {
    assert.ok(read('.gitignore').includes('!build/' + pack + '/.keep'),
      `build/${pack}/.keep is git-ignored: a clone then has no directory to COPY and the build dies again`);
  }
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

test('a bare clone can build the image: every pack directory the image copies is tracked by a keep file', () => {
  // The reason this exists: `COPY build/ledger/` where build/ledger is not in the build context is a hard
  // error, and the packs are derived and git-ignored. Deploying this stack from a clone of the repository
  // died with
  //     failed to solve: failed to compute cache key: "/build/ledger": not found
  // which names no file, no cause and no fix. So the DIRECTORY is tracked, its contents are not: the COPY
  // always has something, and the report below is the place that answers "which packs did I forget".
  for (const pack of ['build/assets/', 'build/shells/', 'build/lods/', 'build/ledger/', 'build/skins/']) {
    assert.ok(DOCKERFILE.includes(`COPY ${pack}`), `Dockerfile does not copy ${pack}`);
    assert.ok(fs.existsSync(`${pack}.keep`), `${pack}.keep is missing - a clone cannot build the image`);
  }
});

test('the image reports a missing pack instead of failing the build, and names the mount that fixes it', () => {
  // Failing the build made the clone case impossible rather than merely incomplete, and the message that
  // reached the user was Docker's. The report must print and continue - and must name the WD_* variable
  // for each pack, because "a pack is missing" without a mount path is the same dead end in a new font.
  const start = DOCKERFILE.indexOf("RUN node -e \"const fs=require('fs');const P=[");
  assert.ok(start >= 0, 'the pack preflight is gone from the Dockerfile');
  const report = DOCKERFILE.slice(start, DOCKERFILE.indexOf('"', start + 40) + 1);
  assert.ok(report.includes('WD_LEDGER'), 'the pack report was truncated while reading it: ' + report.length);
  assert.ok(!/process\.exit\(1\)/.test(report),
    'the pack preflight exits the build: a machine that has not baked anything cannot build the image');
  for (const env of ['WD_ASSETS', 'WD_PACKS', 'WD_LODS', 'WD_LEDGER']) {
    assert.ok(report.includes(env), `the pack report does not name ${env}`);
    assert.ok(COMPOSE.includes(env), `compose.yaml never mentions ${env}: the mounts it documents may point nowhere`);
  }
  // "mount it at the path the image already uses" is only true if those paths are the documented ones.
  for (const dir of ['/srv/app/build/assets', '/srv/app/build/shells', '/srv/app/build/lods', '/srv/app/build/ledger']) {
    assert.ok(COMPOSE.includes(dir), `compose.yaml does not document a mount at ${dir}`);
  }
});

test('worldd refuses to boot without the asset pack, and says which variable fixes it', async () => {
  // In a stack this one line is the whole user-visible answer between restarts. A bare path in the log is
  // how a deploy that "succeeded" ends up looking like a broken map.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmap-nopacks-'));
  const port = 8951 + (process.pid % 40);
  try {
    const child = spawn(process.execPath, ['server/worldd.mjs'], {
      env: {
        ...process.env,
        WD_ASSETS: dir, WD_WORLD: path.join(dir, 'no-such-world'), WD_CACHE: 'none',
        WD_HOST: '127.0.0.1', WD_PORT: String(port), WD_HEARTBEAT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const code = await new Promise((res) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); res(null); }, 20000);
      child.on('exit', (c) => { clearTimeout(t); res(c); });
    });
    assert.equal(code, 1, `it did not refuse to boot without an asset pack (code ${code}):\n${out}`);
    assert.ok(/WD_ASSETS/.test(out), `the boot failure does not name WD_ASSETS:\n${out}`);
    assert.ok(/pack-assets\.mjs/.test(out), `the boot failure does not say how to bake the pack:\n${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the boot log answers "did my mount arrive?", not "does the directory exist"', { skip: needServer() }, async () => {
  // A container built from a clone has every pack directory present, holding one keep file each. Printing
  // the path because it exists tells the operator the opposite of what they need to know.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcmap-emptypacks-'));
  const port = 8991 + (process.pid % 40);
  const child = spawn(process.execPath, ['server/worldd.mjs'], {
    env: {
      ...process.env,
      WD_PACKS: empty, WD_LODS: empty, WD_LEDGER: empty,
      WD_PORT: String(port), WD_HOST: '127.0.0.1', WD_CACHE: 'none', WD_HEARTBEAT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/stats`)).ok; } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, `worldd did not come up with empty pack dirs:\n${out}`);
    for (const env of ['WD_PACKS', 'WD_LODS', 'WD_LEDGER']) {
      assert.ok(out.includes(env), `the boot log never mentions ${env} although its pack directory was empty:\n${out}`);
    }
    assert.ok(!/^shell packs: .*\(0 entries\)/m.test(out), 'it reported an empty pack directory as if it were a pack');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(empty, { recursive: true, force: true });
  }
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
