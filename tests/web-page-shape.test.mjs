// Invariants of the page layer that no headless harness can reach, written as source-shape assertions.
// This is not a style test: each one is a bug that cost a pass, and the only artifact it can be checked
// against is the file itself, because what it guards is a WebGL scene graph or a DOM click handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('web/js/main.js', 'utf8').replace(/\r\n/g, '\n');
const codeLines = src.split('\n').filter((l) => !/^\s*\/\//.test(l));
const bodyOf = (name) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} is gone`);
  return src.slice(at, src.indexOf('\nfunction ', at + 10));
};
const statements = (body) => body.split('\n').map((l) => l.trim());

test('dropChunkMesh is always called with two coordinates, never a key string', () => {
  const calls = codeLines.filter((l) => /dropChunkMesh\(/.test(l));
  assert.ok(calls.length >= 4, `found ${calls.length} call sites, expected at least 4`);
  for (const l of calls) {
    // A template literal or quoted string as the first argument is the bug, in exactly this shape.
    assert.ok(!/dropChunkMesh\(\s*[`'"]/.test(l), `a call passed a string, not coordinates: ${l.trim()}`);
    assert.match(l, /dropChunkMesh\(\s*cx\s*,\s*cz\b/, `a call did not pass (cx, cz): ${l.trim()}`);
  }
});

test('installing a chunk mesh always removes the mesh it replaces', () => {
  const line = statements(bodyOf('attachChunkMesh')).find((l) => l.startsWith('dropChunkMesh('));
  assert.ok(line, 'attachChunkMesh never drops the mesh it replaces');
  assert.equal(line, 'dropChunkMesh(cx, cz, !!(HIST.on && S.keepMesh));',
    'the swap must be unconditional and only the PARKING may depend on the time machine: ' + line);
});

// The other half of the same class: what a click promises. Ticking "time machine" used to arm the tiles and
// leave the voxels showing today, so the feature looked broken from the checkbox and worked from ?time=1.
test('ticking the time machine also arms the block correction, and never over an explicit choice', () => {
  const arm = statements(bodyOf('setTime')).find((l) => l.startsWith('if (!S.timeTouched'));
  assert.ok(arm, 'the checkbox no longer decides whether the voxels follow');
  assert.equal(arm, 'if (!S.timeTouched && !S.timeTerrain) S.timeTerrain = 1;',
    'a choice the viewer made by URL or checkbox must not be re-armed: ' + arm);
});
