// tests/walk.test.mjs - the first-person rig's arithmetic (M11).
//
// The orbit rig is reused for walking by driving its distance to about zero, so most of the view
// policy needs no change. What does need to be right is the small print: a diagonal must not be
// faster, pitch must not flip, Space must not fight Shift, the wheel must not shrink the picture, and
// standing on the ground must never pull a walker out of the cave they are standing in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EYE_DIST, EYE_HEIGHT, PITCH_LIMIT, look, step, wheelReach, walkWant, snapTo, floorUnder, riseToAir,
  sprinting,
} from '../shared/walk.mjs';

const K = (...codes) => new Set(codes);

test('walking follows the yaw, not the pitch: looking up does not walk you backwards', () => {
  // yaw 0 looks along +z in this rig (fwdOf = (sin yaw, 0, cos yaw)), and pitch is not an input here
  const flat = step({ keys: K('KeyW'), yaw: 0, dt: 1, speed: 10 });
  assert.deepEqual([flat.dx, flat.dz, flat.dy], [0, 10, 0], 'W walks forward, and does not fly');
  const east = step({ keys: K('KeyW'), yaw: Math.PI / 2, dt: 1, speed: 10 });
  assert.ok(Math.abs(east.dx - 10) < 1e-9 && Math.abs(east.dz) < 1e-9, 'a quarter turn walks east');
});

test('a diagonal is the same speed as a straight line', () => {
  const straight = step({ keys: K('KeyW'), yaw: 0.3, dt: 0.05, speed: 14 });
  const diagonal = step({ keys: K('KeyW', 'KeyD'), yaw: 0.3, dt: 0.05, speed: 14 });
  assert.ok(Math.abs(Math.hypot(straight.dx, straight.dz) - 14 * 0.05) < 1e-9);
  assert.ok(Math.abs(Math.hypot(diagonal.dx, diagonal.dz) - 14 * 0.05) < 1e-9,
    'the diagonal is the same distance, not sqrt(2) of it');
});

test('A/D strafe, and neither of them turns', () => {
  const d = step({ keys: K('KeyD'), yaw: 0, dt: 1, speed: 1 });
  const a = step({ keys: K('KeyA'), yaw: 0, dt: 1, speed: 1 });
  assert.deepEqual([d.dx, d.dz], [-1, 0], 'right of yaw 0 is -x');
  assert.deepEqual([a.dx, a.dz], [1, 0]);
});

test('Space rises and Shift sinks - Shift is down here, not the orbit speed boost', () => {
  const up = step({ keys: K('Space'), yaw: 0, dt: 1, speed: 10 });
  const down = step({ keys: K('ShiftLeft'), yaw: 0, dt: 1, speed: 10 });
  assert.equal(up.dy, 10);
  assert.equal(down.dy, -10);
  assert.deepEqual([down.dx, down.dz], [0, 0], 'sinking is not moving');
  // a walker with collision off still needs the horizontal and vertical axes independent
  const both = step({ keys: K('KeyW', 'Space'), yaw: 0, dt: 1, speed: 10 });
  assert.deepEqual([both.dz, both.dy], [10, 10]);
  const noFly = step({ keys: K('Space'), yaw: 0, dt: 1, speed: 10, vertical: false });
  assert.equal(noFly.dy, 0, 'vertical: false parks the flight keys');
});

test('Ctrl sprints, and it multiplies rather than adding', () => {
  assert.ok(sprinting(K('ControlRight')));
  assert.ok(!sprinting(K('ShiftLeft')));
  const a = step({ keys: K('KeyW'), yaw: 0, dt: 1, speed: 10, sprint: 2.6 });
  const b = step({ keys: K('KeyW', 'ControlLeft'), yaw: 0, dt: 1, speed: 10, sprint: 2.6 });
  assert.ok(Math.abs(b.dz - a.dz * 2.6) < 1e-9);
});

test('mouse-look cannot flip the world upside down', () => {
  const down = look({ pitch: 0, dy: 1e6, sens: 0.0025 });
  const up = look({ pitch: 0, dy: -1e6, sens: 0.0025 });
  assert.equal(down.pitch, PITCH_LIMIT);
  assert.equal(up.pitch, -PITCH_LIMIT);
  const right = look({ yaw: 0, dx: 100, sens: 0.0025 });
  assert.ok(right.yaw < 0, 'mouse right turns right in this rig (drag-look already does)');
  const inv = look({ yaw: 0, dx: 100, sens: 0.0025, invert: true });
  assert.ok(inv.yaw > 0, 'the invert checkbox applies to look as well as to drag');
});

test('the wheel buys view depth instead of zoom, inside a range', () => {
  assert.equal(wheelReach(400, 0), 400);
  assert.ok(wheelReach(400, 100) > 400, 'scrolling out reaches farther');
  assert.ok(wheelReach(400, -100) < 400);
  assert.equal(wheelReach(100, -1e6), 96, 'never nearer than the near end');
  assert.equal(wheelReach(1000, 1e6), 1600, 'never farther than the save can paint');
  assert.equal(wheelReach(NaN, 0), 96, 'a broken reach resets rather than going infinite');
});

test('what the skin is asked for: the reach, shortened only by fog', () => {
  assert.equal(walkWant(420, 0), 420, 'no fog: ask for the reach');
  assert.ok(walkWant(420, 0.5) <= 420, 'fog: ask for no more than the reach');
  assert.ok(walkWant(1600, 1) >= 1600 * 0.99, 'fog at 1.0 is the reach, not a wall');
  assert.equal(walkWant(NaN, 0), 0);
});

test('the floor under the eye comes from the voxels, not from a heightmap', () => {
  // solid(y) is "something you can stand on at world Y in the column under the eye"
  const ground = (y) => y <= 70;
  assert.equal(floorUnder(ground, 72), 70, 'scan down from the eye, inclusive');
  assert.equal(floorUnder(ground, 70), 70, 'an eye inside the floor still finds it');
  assert.ok(Number.isNaN(floorUnder(() => false, 72)), 'air all the way down is a hole, not a floor');
  assert.ok(Number.isNaN(floorUnder(ground, 90, 10)), 'a floor 20 blocks down is not what you stand on');
  // a floating island: the first thing below the eye wins, not the highest thing in the column
  const island = (y) => (y >= 60 && y <= 62) || y <= 40;
  assert.equal(floorUnder(island, 70), 62, 'land on the island, not on the seabed under it');
});

test('an eye inside a hill climbs out of it; an eye in a cavern does not', () => {
  const ground = (y) => y <= 70;
  assert.equal(riseToAir(ground, 65), 71.5, 'a goto inside a hill starts above it');
  assert.equal(riseToAir(ground, 72.5), 72.5, 'already in air: do not move');
  assert.equal(riseToAir(ground, 71.0), 71.0, 'in the air block right at the surface: do not move');
  assert.equal(riseToAir(() => true, 30), 30, 'deep underground there is no air to climb to - stay put');
});

test('standing on the ground never pulls a walker out of a cave', () => {
  // the eye sits EYE_HEIGHT above the top face of the block it stands on
  assert.ok(Math.abs(snapTo(70, 72.0, {}) - (70 + 1 + EYE_HEIGHT)) < 1e-9);
  assert.ok(Math.abs(snapTo(70, 72.62, {}) - 72.62) < 1e-9, 'already standing: no drift');
  // deep underground, or flying on purpose: leave the eye where it is
  assert.equal(snapTo(120, 30, {}), 30, 'a 90 block pull would teleport you out of the mine');
  assert.equal(snapTo(30, 90, {}), 90, 'and the same upwards');
  // nothing held under the eye is not the floor rising to meet you
  assert.equal(snapTo(NaN, 65, {}), 65);
  assert.equal(snapTo(70, 72, { on: false }), 72, '?nosnap leaves the eye alone');
  // a step, not a snap: within maxStep the eye ends on the surface; just past it, it does not move
  assert.ok(Math.abs(snapTo(70, 70.3, { maxStep: 2.4 }) - (70 + 1 + EYE_HEIGHT)) < 1e-9);
  assert.equal(snapTo(70, 70.2, { maxStep: 2.4 }), 70.2, 'the nudge stops at maxStep - a wall is a wall');
});

test('the walking rig is the orbit rig with a near-zero distance', () => {
  // shared/view.mjs sizes the frustum from this distance; a walker needs a near plane below a block
  // and no lift, and detailRadius(0,..) is the whole ring around the eye.
  assert.ok(EYE_DIST > 0 && EYE_DIST < 0.5, 'a real (non-zero) separation for lookAt');
});
