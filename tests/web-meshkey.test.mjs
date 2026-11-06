// 9.6: a chunk is meshed once per (payload + the border the mesher reads).
//
// The store marks a chunk dirty when it arrives and again whenever any neighbour arrives or leaves, so
// without a key the same chunk builds the same triangles up to five times per streaming wave. The key
// is the payload's identity, the eight neighbours' identities, what the far skin owns around it, and
// the mesh settings. Two rules are load-bearing and tested here: a known neighbour must never be
// confused with an unknown one, and a replaced payload must never look like the one it replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meshKeyTool } from '../web/js/mesh-key.js';

const mk = (chunks, holes = []) => {
  const held = chunks;                      // not copied: a test must be able to replace a payload
  const miss = new Set(holes);
  return meshKeyTool((cx, cz) => held.get(`${cx},${cz}`) ?? null, (cx, cz) => miss.has(`${cx},${cz}`));
};

// A "chunk" only needs to be a distinct object: the stamp is identity, not content.
const payload = {};

test('the same payload and the same known border is the same answer', () => {
  const c = {};
  const t = mk(new Map([['0,0', c], ['1,0', {}], ['0,1', {}]]));
  assert.equal(t.key(0, 0, 'S'), t.key(0, 0, 'S'), 'asked twice with nothing changed: same key');
});

test('a neighbour turning up changes the answer, because unknown is not air', () => {
  const t0 = mk(new Map([['0,0', payload]]));
  const before = t0.key(0, 0, 'S');
  assert.equal(t0.settled(0, 0), false, 'a neighbour that might still arrive means unsettled');
  const t1 = mk(new Map([['0,0', payload], ['1,0', {}], ['-1,0', {}], ['0,1', {}], ['0,-1', {}],
    ['1,1', {}], ['1,-1', {}], ['-1,1', {}], ['-1,-1', {}]]));
  assert.equal(t1.settled(0, 0), true, 'all eight held');
  assert.notEqual(t1.key(0, 0, 'S'), before, 'the wall against a real neighbour is not the wall against nothing');
});

test('a confirmed hole settles, and is still different from a chunk', () => {
  const t = mk(new Map([['0,0', payload]]), ['1,0', '-1,0', '0,1', '0,-1', '1,1', '1,-1', '-1,1', '-1,-1']);
  assert.equal(t.settled(0, 0), true, 'the server said no more chunks are here: stop waiting');
  const withOne = mk(new Map([['0,0', payload], ['1,0', {}]]),
    ['-1,0', '0,1', '0,-1', '1,1', '1,-1', '-1,1', '-1,-1']);
  assert.notEqual(withOne.key(0, 0, 'S'), t.key(0, 0, 'S'), 'a held neighbour and a hole are different ground');
});

test('a re-fetched payload is a different payload', () => {
  // The stamp is identity, so a payload replaced by a re-fetch (a light fixup, a save edit) must not
  // keep the old mesh. Stamps are per tool, so this is one tool watching one store.
  const held = new Map([['0,0', {}], ['1,0', {}], ['-1,0', {}], ['0,1', {}], ['0,-1', {}],
    ['1,1', {}], ['1,-1', {}], ['-1,1', {}], ['-1,-1', {}]]);
  const t = mk(held);
  const before = t.key(0, 0, 'S');
  assert.equal(t.key(0, 0, 'S'), before, 'nothing changed: same key');
  held.set('0,0', {});                      // the chunk itself re-fetched
  const mine = t.key(0, 0, 'S');
  assert.notEqual(mine, before, 'the voxels behind the mesh changed');
  held.set('1,1', {});                      // a diagonal re-fetched
  assert.notEqual(t.key(0, 0, 'S'), mine, 'a diagonal payload is part of this corner too');
});

test('settings and far-skin ownership are part of the answer', () => {
  const t = mk(new Map([['0,0', payload]]));
  assert.notEqual(t.key(0, 0, 'S'), t.key(0, 0, 'S-caves-on'), 'cave rules change which faces exist');
  assert.notEqual(t.key(0, 0, 'S', ''), t.key(0, 0, 'S', '1:0'), 'a neighbour the far skin owns is a wall the mesher skips');
});

test('diagonals count: AO and the corner wall read them too', () => {
  const base = [['0,0', payload], ['1,0', {}], ['-1,0', {}], ['0,1', {}], ['0,-1', {}]];
  const t0 = mk(new Map(base));
  const t1 = mk(new Map([...base, ['1,1', {}]]));
  assert.notEqual(t0.key(0, 0, 'S'), t1.key(0, 0, 'S'), 'a diagonal arriving changes the corner');
});

test('the same bytes twice are the same ground, and that is the whole saving', () => {
  // Identity alone could not see this: panning away and back refetches untouched ground as a brand new
  // object, which used to throw away every parked triangle set and re-cut the border. Measured on one
  // 400-block pan at a 1.2 km pull-back: 66-83 rebuilds on the return leg, `reused 0`, every time.
  const held1 = new Map([['0,0', { digest: 11 }], ['1,0', { digest: 22 }]]);
  const before = mk(held1).key(0, 0, 'S');
  const held2 = new Map([['0,0', { digest: 11 }], ['1,0', { digest: 99 }]]);
  assert.notEqual(mk(held2).key(0, 0, 'S'), before, 'different bytes are different ground');
  const held3 = new Map([['0,0', { digest: 11 }], ['1,0', { digest: 22 }]]);
  assert.equal(mk(held3).key(0, 0, 'S'), before, 'a second copy of the same bytes is not new ground');
  const held4 = new Map([['0,0', { digest: 12 }], ['1,0', { digest: 22 }]]);
  assert.notEqual(mk(held4).key(0, 0, 'S'), before, 'and an edited chunk still has to be re-cut');
});
