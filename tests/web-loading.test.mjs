// The loading bar's POLICY, with a fake clock. A bar is a promise to the reader - "this much is left" - so
// the promise gets tested the way a mesher's output does: numbers in, numbers out, no screenshot needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgress, STALE_MS } from '../web/js/loading.js';

const rig = (t0 = 0) => { let now = t0; return { clock: () => now, to: (ms) => { now = ms; } }; };

test('everything with a total gives a fraction, and the weakest link decides it', () => {
  const r = rig();
  const p = createProgress({ clock: r.clock });
  p.note('chunks', { done: 40, total: 200, label: 'chunks', unit: 'in' });
  p.note('meshes', { done: 10, total: 50, label: 'meshes' });
  const s = p.snapshot();
  assert.equal(s.shape, 'bar', 'two counted kinds of work is a bar');
  assert.equal(s.pct, 0.2, 'the least finished part is the fraction, not the most finished one');
  assert.equal(s.pending, 2);
  assert.match(s.text, /chunks: 40\/200 in/, 'the sentence carries the counts, with the unit');
  assert.match(s.text, /meshes: 10\/50/);
  // The dominant wait leads: 160 chunks owed beats 40 meshes owed.
  assert.ok(s.text.indexOf('chunks') < s.text.indexOf('meshes'), s.text);
});

test('work with no total is a stripe, and never a made-up fraction', () => {
  const r = rig();
  const p = createProgress({ clock: r.clock });
  p.note('patches', { done: 7, total: null, label: 'far ground', unit: 'dirty' });
  p.note('chunks', { done: 180, total: 200, label: 'chunks' });
  const s = p.snapshot();
  assert.equal(s.shape, 'stripe', 'an uncounted wait cannot be a percentage');
  assert.equal(s.pct, null, 'a number here would be invented');
  assert.ok(s.text.startsWith('far ground: 7 dirty'), 'and the uncertain thing leads the sentence');
  // A part with a NaN / negative total is the same honest case, not a division by nothing.
  p.note('patches', { done: 3, total: NaN });
  assert.equal(p.snapshot().shape, 'stripe');
});

test('finished work stops holding the bar, and so does work nobody reported any more', () => {
  const r = rig();
  const p = createProgress({ clock: r.clock });
  p.note('chunks', { done: 40, total: 200, label: 'chunks' });
  p.note('chunks', { done: 200, total: 200, label: 'chunks' });
  p.note('meshes', { done: 5, total: 9, label: 'meshes' });
  let s = p.snapshot();
  assert.equal(s.pending, 1, 'a finished part is not pending work');
  assert.equal(s.pct, 5 / 9, 'and it stops dragging the fraction down');
  // The panic that must not freeze: a counter reported once and then forgotten.
  r.to(STALE_MS + 10);
  s = p.snapshot();
  assert.equal(s.shape, 'settled', 'an unreported counter became irrelevant, not a permanent 44% bar');
  assert.equal(s.pct, 1);
  assert.equal(s.text, '');
});

test('a part that keeps being reported keeps its place, and a re-note is not a new part', () => {
  const r = rig();
  const p = createProgress({ clock: r.clock });
  for (let t = 0; t <= 3 * STALE_MS; t += 300) {
    r.to(t);
    p.note('chunks', { done: t / 300 * 10, total: 200, label: 'chunks' });
  }
  const s = p.snapshot();
  assert.equal(s.pending, 1, 'the same key re-reported is one part');
  assert.equal(s.parts.length, 1);
  assert.equal(s.done, undefined);
  assert.equal(s.pct, 0.75, 'a creeping bar is allowed while it creeps'); assert.ok(s.pct < 1, `a creeping bar is allowed while it creeps (${s.pct})`);
});

test('a bar never claims it is finished while something is still owed', () => {
  const p = createProgress({ clock: () => 0 });
  p.note('chunks', { done: 199, total: 200 });
  p.note('timeline', { done: 12, total: 12 });           // finished
  const s = p.snapshot();
  assert.ok(s.pct < 1, 'one block short of ground is not a full bar');
  assert.equal(s.shape, 'bar');
  p.clear('chunks');
  assert.equal(p.snapshot().shape, 'settled', 'and saying it is done makes it done');
});

test('reset(): a new dimension, a new world, other numbers', () => {
  const p = createProgress({ clock: () => 0 });
  p.note('chunks', { done: 4, total: 200 });
  p.note('timeline', { done: 1, total: 400000 });
  p.reset();
  const s = p.snapshot();
  assert.equal(s.shape, 'settled', 'the old world\'s counts must not follow the page into the new one');
  assert.equal(s.parts.length, 0);
});

test('a zero-total part is finished arithmetic, not a divide-by-nothing panic', () => {
  const p = createProgress({ clock: () => 0 });
  p.note('patches', { done: 0, total: 0, label: 'far ground' });
  assert.equal(p.snapshot().shape, 'settled');
  p.note('patches', { done: 0, total: 0 });
  p.note('chunks', { done: 3, total: 10 });
  assert.equal(p.snapshot().pct, 0.3, 'a part with nothing to do does not drag the bar to 0');
});

test('the sentence stays a sentence: three parts, and the biggest waits first', () => {
  const p = createProgress({ clock: () => 0 });
  p.note('a', { done: 1, total: 10, label: 'one' });
  p.note('b', { done: 1, total: 1000, label: 'two' });
  p.note('c', { done: 1, total: 100000, label: 'three' });
  p.note('d', { done: 1, total: 5, label: 'four' });
  const s = p.snapshot();
  const names = s.text.split(' · ');
  assert.equal(names.length, 3, 'a HUD line is three things long, not four');
  assert.deepEqual(names.map((x) => x.split(':')[0]), ['three', 'two', 'one']);
  assert.ok(s.text.length < 120, `the line has to fit a panel: ${s.text}`);
});

test('an uncounted wait is phrased once, not twice, and a zero-count wait is a label', () => {
  const p = createProgress({ clock: () => 0 });
  // The page reports "455 patches to re-cut" as done=455 + unit="patches to re-cut". A unit that repeats the
  // count prints the number twice - "far ground: 455 455 patches to re-cut" - which is what it did.
  p.note('far', { done: 455, total: null, label: 'far ground', unit: 'patches to re-cut' });
  assert.equal(p.snapshot().text, 'far ground: 455 patches to re-cut');
  assert.equal(p.snapshot().shape, 'stripe', 'no total, so no fraction');
  // A wait with nothing counted yet is a name, not "the action log: 0".
  p.note('log', { done: 0, total: null, label: 'the action log' });
  assert.equal(p.snapshot().text, 'far ground: 455 patches to re-cut · the action log',
    'two uncounted waits tie at "infinitely owed", so the line keeps a STABLE order - a HUD sentence that '
    + 'reshuffles every frame is unreadable');
});
