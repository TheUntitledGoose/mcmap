// Request-path batching must yield the event loop (server/world-service.mjs *Async methods).
//
// One 32x32 far-terrain batch over an unbaked region is ~1000 chunk decodes. Run as a single
// synchronous loop it holds the only thread for ~13 s, so the browser's detail requests - which are
// the ones it actually needs first - sit behind it. From the user's side that is indistinguishable
// from "one chunk per second", which is exactly what it was.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { openShellBatch } from '../web/js/payload.js';

const atlas = JSON.parse(fs.readFileSync(path.join('build', 'assets', 'atlas.json'), 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const ids = buildStateIds(atlas.states.map((s) => s.k));
// packDir 'none': nothing is baked here, so every column really does cost a chunk decode.
const svc = () => new WorldService('DarkRPG/world', ids, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
  packDir: null,
});

const DIM = 'minecraft:overworld';
// A populated corner of the save, so the batch is doing real work rather than probing holes.
const CX = -20, CZ = -30;

test('async batch yields the loop while it decodes; the sync batch does not', async () => {
  // The ticker must be real async I/O, not an immediate or a timer: `await new Promise(setImmediate)`
  // lets the batch's own promise continuation re-enter before the next immediate fires, so a CPU-side
  // ticker can starve even when the loop is genuinely yielding. Incoming HTTP requests are libuv I/O
  // events, which is what this has to make room for - and a file read completes the same way.
  const probe = path.join('build', 'assets', 'atlas.png');
  const pumpIO = async (state) => {
    for (;;) {
      await fs.promises.readFile(probe);
      // A read issued before a blocking loop still completes afterwards; only completions that land
      // while the batch is still running count as interleaving.
      if (state.stop) return;
      state.ticks++;
    }
  };
  const svcA = svc();
  const a = { ticks: 0, stop: false };
  const pumpA = pumpIO(a);
  const buf = await svcA.shellBatchBytesAsync(DIM, CX, CZ, 6, 6, 2);
  a.stop = true;
  await pumpA;
  assert.ok(buf.length > 1000, 'expected real shell frames');
  assert.ok(a.ticks > 0, 'the request path must let other work run between chunks');

  const svcB = svc();
  const b = { ticks: 0, stop: false };
  const pumpB = pumpIO(b);
  const buf2 = svcB.shellBatchBytes(DIM, CX, CZ, 6, 6);
  b.stop = true;
  await pumpB;
  assert.equal(buf2.length, buf.length, 'sync and async batches must produce the same bytes');
  assert.equal(b.ticks, 0, 'the bake/test path is expected to hold the thread');
});

test('async batch bytes decode as a shell batch on the browser side', async () => {
  const buf = await svc().shellBatchBytesAsync(DIM, CX, CZ, 3, 2);
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  const frames = openShellBatch(ab(buf));
  assert.equal(frames.length, 6);
  assert.ok(frames.some((f) => f), 'at least one populated chunk in the patch');
});

test('a pack baked after the server started stops being remembered as missing', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('.'), 'build', 'packmiss-'));
  try {
    const s = new WorldService('DarkRPG/world', ids, 'build/cache', {
      isCubeState: (id) => cls.cube[id - 1] === 1,
      isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
      isSolidState: (id) => cls.cube[id - 1] === 1,
      packDir: dir, stamp: 1234,
    });
    const dim = s.resolve(DIM);
    const k = `${dim.key}|3,4`;
    assert.equal(s.packFor(dim, 3, 4), null);
    assert.equal(s.packs.get(k), null, 'the miss should be remembered, not re-statted every call');
    const first = s.packMissAt.get(k);
    assert.ok(first >= Date.now() - 1000, 'a miss is timestamped');
    // Same call again must not re-stat while the miss is young.
    assert.equal(s.packFor(dim, 3, 4), null);
    assert.equal(s.packMissAt.get(k), first, 'a young miss is trusted');
    // Backdate it: the next call must look again, which is how a bake that finished mid-session gets
    // picked up without restarting the server.
    // A sentinel from the epoch: if the code re-checks, the stamp comes back as "now", and Date.now()
    // granularity is too coarse to compare two fresh stamps against each other.
    s.packMissAt.set(k, 1);
    assert.equal(s.packFor(dim, 3, 4), null);
    assert.ok(s.packMissAt.get(k) > 1e9, 'a stale miss is re-checked, not trusted forever');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty far block costs work, not event-loop turns', async () => {
  // 64x64 of ground that was never written: ~10 ms of header reading. Counting yields by slot count put
  // 85 `setImmediate` turns inside it, and each turn queued behind whatever else was in flight, which
  // is how an empty tile came back in 435 ms (build/dbg-farpan.mjs, 11/07).
  const s = svc();
  let ticks = 0, stop = false;
  const tick = async () => { while (!stop) { await new Promise((r) => setImmediate(r)); ticks++; } };
  const t = tick();
  const t0 = performance.now();
  const buf = await s.shellBatchBytesAsync(DIM, -9000, 5000, 64, 64);
  const ms = performance.now() - t0;
  stop = true;
  await t;
  assert.ok(buf.length > 8, 'an empty block is still a batch of empty frames');
  assert.ok(ms < 250, `64x64 of unwritten ground took ${ms.toFixed(0)} ms`);
  assert.ok(ticks < 60, `the batch cost ${ticks} event-loop turns for ${ms.toFixed(0)} ms`);
});
