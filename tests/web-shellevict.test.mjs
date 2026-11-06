// Evicting the far skin used to be a full walk of the held set on every arriving batch. At
// whole-world radius the held set is ~37 000 chunks, and a pan makes hundreds of batches arrive, so
// the viewer spent more time noticing that chunks were out of date than using them: 4.3% of the page's
// CPU measured inside one function. A sweep now happens when the box changes, and the sweep itself
// walks the live Map instead of copying its keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellStore } from '../web/js/shell-store.js';
import { shellFrameCols } from '../server/shell.mjs';
import { packBatch } from '../server/world-service.mjs';
import { SHELL_COLS, HEIGHT_BIAS } from '../shared/chunk-format.mjs';

const N = SHELL_COLS;
// A plausible column set: rolling ground, grass paint, one block of skin thickness, day light.
function frameBytes(cx, cz) {
  const h = new Uint16Array(N), cover = new Uint16Array(N), g = new Uint16Array(N), s = new Uint16Array(N);
  const light = new Uint8Array(N), band = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const top = 64 + ((cx + cz + i) & 7);
    h[i] = top + HEIGHT_BIAS; g[i] = top + HEIGHT_BIAS; cover[i] = 1; s[i] = 1;
    light[i] = 0xff; band[i] = 1;
  }
  return shellFrameCols(cx, cz, h, cover, g, s, light, band);
}

// Fake server: answer every /shells tile with real batch bytes. `holes` answers a tile with only one
// frame so the store records the rest as confirmed-missing.
function fakeServer({ holes = false } = {}) {
  const urls = [];
  globalThis.fetch = (url) => {
    urls.push(url);
    const q = new URL(url, 'http://x').searchParams;
    const cx0 = +q.get('cx0'), cz0 = +q.get('cz0'), w = +q.get('w'), h = +q.get('h');
    const frames = [];
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        if (holes && !(dx === 0 && dz === 0)) continue;      // everything else is a confirmed hole
        frames.push(frameBytes(cx0 + dx, cz0 + dz));
      }
    }
    const buf = packBatch(frames);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return Promise.resolve({ ok: true, arrayBuffer: async () => ab });
  };
  return { urls };
}

const settle = async (st) => {
  for (let i = 0; i < 400 && (st.queue.length || st.busy || st.pending.size); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(st.queue.length, 0, 'the queue drained');
  assert.equal(st.busy, 0, 'nothing in flight');
};

test('one box change is one sweep, no matter how many batches arrive', async () => {
  fakeServer();
  const st = new ShellStore('minecraft:overworld', { tile: 8, keep: 2, maxConcurrent: 4 });
  st.request(0, 0, 12, 0);
  await settle(st);
  const side = 2 * 12 + 1;
  assert.equal(st.loaded, side * side, 'the whole square is held');
  // 9 tiles arrived. Each of them used to trigger a full walk of whatever was held at that moment.
  assert.equal(st.evSweeps, 1, 'the box changed once, so it was swept once');
  assert.ok(st.evSkipped >= 8, `later batches skipped the sweep (skipped ${st.evSkipped})`);
  assert.ok(st.evVisited <= side * side + 64,
    `one pass over the held set, not one per batch (visited ${st.evVisited})`);
});

test('a moved box evicts, and evicts from the live map without stranding anything', async () => {
  fakeServer();
  const st = new ShellStore('minecraft:overworld', { tile: 8, keep: 2, maxConcurrent: 4 });
  st.request(0, 0, 12, 0);
  await settle(st);
  st.request(40, 0, 12, 0);
  await settle(st);
  const limit = 12 + 2;
  const out = [];
  for (const s of st.shells.values()) {
    if (Math.abs(s.cx - 40) > limit || Math.abs(s.cz) > limit) out.push(`${s.cx},${s.cz}`);
  }
  assert.deepEqual(out, [], 'nothing outside the new box survives');
  assert.ok(st.loaded > 0, 'and the new box is filled');
  assert.equal(st.evSweeps, 2, 'two boxes, two sweeps');
  // Eviction marks what it removed, or a patch keeps drawing a shell that is no longer held.
  assert.ok(st.dirty.size > 0, 'evicted chunks mark their patches dirty');
});

test('confirmed holes expire with the box too', async () => {
  const { urls } = fakeServer({ holes: true });
  const st = new ShellStore('minecraft:overworld', { tile: 8, keep: 2, maxConcurrent: 4 });
  st.request(0, 0, 4, 0);
  await settle(st);
  assert.ok(st.missing.size > 30, `holes were recorded (${st.missing.size})`);
  st.request(200, 0, 4, 0);
  await settle(st);
  for (const k of st.missing) {
    const [mx, mz] = k.split(',').map(Number);
    assert.ok(Math.abs(mx - 200) <= 6 && Math.abs(mz) <= 6, `hole ${k} expired with the box`);
  }
  assert.ok(urls.length >= 2, 'the fake server was actually asked twice');
});
