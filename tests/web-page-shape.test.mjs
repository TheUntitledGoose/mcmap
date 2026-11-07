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

// The arm promise has two entry points, and the first version of the fix only covered one of them: a page
// that boots with ?time=1 never calls setTime, so it sat at second 0 and drew an empty map.
test('a fresh time arm is marked on BOTH entry points, and the rebuild decides where it starts', () => {
  assert.match(bodyOf('setTime'), /TLAYER\.freshArm = 1;/, 'the checkbox path lost its fresh-arm mark');
  assert.match(bodyOf('timeLoad'), /TLAYER\.freshArm = 1;/, 'the ?time=1 boot path lost its fresh-arm mark');
  const rb = bodyOf('timeRebuild');
  assert.match(rb, /if \(TLAYER\.freshArm\)/, 'nothing consumes the fresh arm');
  assert.match(rb, /if \(S\.playTouched\) timeSeekRow\(TLAYER\.quads - 1\);/,
    'an explicitly paused arm must start at the END of the filter');
  assert.match(rb, /else \{ S\.timePlay = 1; timeSeekRow\(0\); \}/,
    'an arm nobody paused must start playing at the first logged change, not at second 0');
});

// Two bugs of this pass, both invisible to every counter: a ray hit index treated as an item index, and a
// 40 ms marker raycast sitting inside a 90 ms hover loop.
test('a time-layer hit maps a TRIANGLE index to an item, and the hover path never raycasts', () => {
  const hit = bodyOf('timeHitAt');
  assert.match(hit, /markerOfIndex\(TLAYER\.markerEnd, Math\.floor\(q \/ 2\) \* 6\)/,
    'faceIndex is a triangle number; markerEnd counts indices');
  for (const fn of ['hoverPass', 'hoverVoxel']) {
    const b = bodyOf(fn);
    assert.ok(!/intersectObject/.test(b), `${fn} raycasts a mesh: a hover pays a click's 40 ms`);
  }
  // What the hover may ask cheaply, and the skip path must say why it skipped - a stale 'off' from the last
  // time the highlight was disabled reads as a setting the viewer never made.
  assert.match(bodyOf('hoverVoxel'), /timeDrawnAt\(/, 'the outline lost its cheap drawn-change question');
  assert.match(bodyOf('hoverPass'), /HOVER\.skips\+\+; HOVER\.why = 'nothing moved'/,
    'a skipped hover pass leaves the previous reason behind, which is a lie about the setting');
});

// A click used to answer only if an overlay had already been switched on, which made "nothing happened" the
// symptom of a perfectly ordinary click on a block.
test('a click loads the ledger itself instead of requiring an overlay first', () => {
  const ask = bodyOf('askAt');
  assert.match(ask, /await ledgerMetaLoad\(\)/, 'askAt no longer fetches /ledger/meta on demand');
  assert.match(ask, /timeHitAt\(x, y\)/, 'a click on a drawn marker no longer answers with its own row');
  // There are two click listeners on the same canvas: walk mode wants the pointer, orbit mode asks the
  // question. Start from the call and walk back to the listener that owns it.
  const atCall = src.indexOf('askAt(e.clientX, e.clientY)');
  assert.ok(atCall > 0, 'no orbit-mode click asks anything any more');
  const click = src.slice(src.lastIndexOf("canvas.addEventListener('click'", atCall), atCall + 60);
  assert.match(click, /if \(walk\.on\) return;/, 'the orbit click handler lost its walk-mode guard');
  assert.match(click, /askAt\(e\.clientX, e\.clientY\)/, 'the click handler went back to its own gate');
  assert.ok(!/if \(!LEDGER\.meta\?\.available\)/.test(click),
    'the click handler re-added the "turn an overlay on first" gate: ' + click.slice(0, 160));
});
