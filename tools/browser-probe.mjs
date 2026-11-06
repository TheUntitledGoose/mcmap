// browser-probe — drive headless Edge over the Chrome DevTools Protocol so the renderer can be
// verified without a human in the loop: console output, uncaught errors, WebGL capability,
// __world.state from the page, and a screenshot.
//
//   node tools/browser-probe.mjs [--url http://127.0.0.1:8765/] [--out build/probe.png]
//     [--wait 7000] [--goto "0,112,0"] [--orbit "0.7,0.42,40"] [--eval "expr"]... [--keep]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);

// Which switches consume the next token. Anything else that is not a --flag is a positional, and the
// positional that looks like a URL is the page to open. Without this, `node tools/browser-probe.mjs
// "http://...&lodclip=0"` silently loaded the *default* URL instead: every A/B in that run measured
// the same page twice and reported a 1% difference as if it were a finding.
const VALUED = ['url', 'out', 'wait', 'port', 'width', 'height', 'edge', 'profile', 'goto', 'orbit',
  'eval', 'shot', 'click', 'keys'];
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUED.includes(argv[i].slice(2))) i++; continue; }
  pos.push(argv[i]);
}
const URL0 = arg('url', pos.find((p) => /^https?:\/\//.test(p)) ?? 'http://127.0.0.1:8765/');
const stray = pos.filter((p) => !/^https?:\/\//.test(p));
if (stray.length) console.log(`probe: ignoring positional argument(s) ${JSON.stringify(stray)}`);
if (!pos.includes(URL0) && !argv.includes('--url')) console.log('probe: no URL given, using ' + URL0);
const OUT = path.resolve(arg('out', 'build/probe.png'));
const WAIT = +arg('wait', 7000);
const PORT = +arg('port', 9223);
const SHOT = arg('shot', null);            // --shot 480x270: a small frame is quicker to read and diff
const W = +arg('width', SHOT ? +SHOT.split('x')[0] : 1280);
const H = +arg('height', SHOT ? +SHOT.split('x')[1] : 800);
const EDGE = arg('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const PROFILE = arg('profile') || fs.mkdtempSync(path.join(os.tmpdir(), 'pi-edge-'));

// Runs that were killed mid-flight (timeout, Ctrl-C) cannot clean up after themselves, and an Edge
// profile is tens of MB. Sweep anything older than an hour before starting.
try {
  const cut = Date.now() - 3600e3;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('pi-edge-')) continue;
    const p = path.join(os.tmpdir(), name);
    try { if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { recursive: true, force: true }); } catch { }
  }
} catch { }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disk-cache-size=1',
  // Software rasterisation by default: it makes the numeric framebuffer probes bit-reproducible.
  // It also means the fps in the HUD is worthless - pass --gpu to measure against the real GPU.
  ...(flag('gpu') ? ['--use-angle=d3d11'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader']),
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browserErr = '';
browser.stderr.on('data', (d) => { browserErr += d.toString(); });

const killBrowser = () => {
  // Edge spawns a process tree; killing the parent alone leaves the renderer holding the profile
  spawn('taskkill', ['/F', '/T', '/PID', String(browser.pid)], { stdio: 'ignore' });
};

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`no CDP page target on :${PORT}\n${browserErr}`);
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let nextId = 1;
const pending = new Map();
const console_ = [];
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const a = (m.params.args ?? []).map((x) => x.value ?? x.description ?? x.type).join(' ');
    console_.push(`${m.params.type}: ${a}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description ?? d.exception?.value ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}`);
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') errors.push(`log/${e.level}: ${e.text} ${e.url ?? ''}`);
  }
});

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expr) => {
  // A plain Runtime.evaluate runs a *script*, and a script body has no top-level await, so a probe that
  // wants to wait for chunks to arrive (a promise, not a tick) is wrapped instead. Wrapped probes must
  // `return` their value; every existing probe is an expression or statements and stays as-is.
  const expression = /\bawait\b/.test(expr) ? `(async () => { ${expr} })()` : expr;
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
// Probing the same URL over and over is the normal loop here, so the HTTP cache must be off or the
// browser keeps rendering yesterday's main.js and every conclusion drawn from a screenshot is junk.
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const caps = await evaluate(`(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  return { webgl2: !!gl, maxTex: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0,
           renderer: gl ? gl.getParameter(gl.RENDERER) : null };
})()`);
console.log('browser caps:', JSON.stringify(caps));

await send('Page.navigate', { url: URL0 });
await sleep(WAIT);

if (flag('goto')) {
  const [x, y, z] = arg('goto').split(',').map(Number);
  await evaluate(`__world.go(${x}, ${y}, ${z})`);
  await sleep(+arg('after', 3500));
}
if (flag('orbit')) {
  const [yaw, pitch, dist] = arg('orbit').split(',').map((v) => (v === '' ? null : Number(v)));
  await evaluate(`__world.orbit(${yaw}, ${pitch}, ${dist})`);
  await sleep(900);
}

const evals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--eval') evals.push(argv[++i]);
  // Long page-side probes do not survive shell quoting; keep them in a file and paste them in.
  else if (argv[i] === '--eval-file') evals.push(fs.readFileSync(argv[++i], 'utf8'));
}
for (const [n, expr] of evals.entries()) {
  // A file-sized eval echoed back is noise; name it and keep the result readable.
  const label = expr.length > 70 ? `eval #${n + 1} (${expr.length} chars)` : `eval ${expr}`;
  try { console.log(`${label} =>`, JSON.stringify(await evaluate(expr), null, 1)); }
  catch (e) { console.log(`${label} => ERROR ${e.message}`); }
  // Settle after *every* eval, not just at the end: a camera eval only says "I want this view",
  // and the frame loop has to run before the next eval (or the screenshot) sees that view.
  if (flag('post')) await sleep(+arg('post'));
}

try {
  console.log('page state:', JSON.stringify(await evaluate('__world && __world.state'), null, 1));
} catch (e) { console.log('page state: unavailable -', e.message); }

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`screenshot: ${OUT}`);

if (console_.length) console.log('console:\n  ' + console_.join('\n  '));
// A module that fails to parse leaves the page blank, and a blank screenshot reads as a rendering
// bug unless the page errors are called out next to it.
if (errors.length) console.log(`errors (${errors.length}, the screenshot is probably blank):\n  ` + errors.join('\n  '));

ws.close();
if (!flag('keep')) killBrowser(); else console.log(`browser left running on :${PORT}`);
// An Edge profile is 30-60 MB of cache and component data; leaving one behind per probe run is
// how a debug loop quietly eats a gigabyte. Windows keeps handles open for a moment after the
// kill, hence the retries.
if (!flag('keep') && !flag('keep-profile')) {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  } catch (e) {
    // Edge still holds handles for a moment after the kill, so finish the job out of band.
    const ps = `Start-Sleep 4; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${PROFILE}'`;
    spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log(`(profile dir queued for deletion: ${PROFILE} - ${e.code})`);
  }
}
process.exit(errors.length ? 2 : 0);
