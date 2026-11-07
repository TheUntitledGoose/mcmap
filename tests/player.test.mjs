// The player body, against synthetic voxel worlds. Everything here is the physics the page uses:
// gravity, jumping, walls, slabs, ladders, water, the bottom of the world, and what happens when the
// voxels under you have not streamed in yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY, C_CLIMB, C_FULL, C_LIQUID, C_UNKNOWN, CLIMB_V, FALL_MAX, GRAVITY, JUMP_V, STEP_UP, TICK,
  WALK, SPRINT, collisionTable, bodyRule, eyeY, newPlayer, place, settleOntoFloor, simulate,
  stateFootprints, stateHeights, F_FLAT, F_NONE, F_THIN, dropToClear, hits,
} from '../shared/player.mjs';

// A voxel world from a sparse map; anything not listed and not in the unknown region is air.
const mkWorld = (map, unknownFn = null) => (x, y, z) => {
  const v = map.get(`${x},${y},${z}`);
  if (v !== undefined) return v;
  if (unknownFn && unknownFn(x, y, z)) return C_UNKNOWN;
  return 0;
};
// Floor covering x/z in [-8, 8] with its top face at `top` (the floor cell is top-1).
const floorMap = (top, half = 24, h16 = C_FULL) => {
  const m = new Map();
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) m.set(`${x},${top - 1},${z}`, h16);
  }
  return m;
};
const run = (p, input, seconds, cell, opts) => {
  const out = [];
  for (let t = 0; t < seconds; t += 1 / 60) out.push(simulate(p, input, 1 / 60, cell, opts));
  return out;
};

test('gravity lands the feet on the floor and stops there', () => {
  const cell = mkWorld(floorMap(7));
  const p = newPlayer(0, 20, 0);
  run(p, {}, 2, cell);
  assert.equal(p.y, 7, `feet ${p.y}`);
  assert.equal(p.onGround, 1);
  assert.equal(p.vy, 0);
  assert.ok(eyeY(p) > p.y, 'the eye is above the feet');
  // ... and it stays put: no jitter, no re-fall
  const y0 = p.y;
  run(p, {}, 1, cell);
  assert.equal(p.y, y0);
});

test('a wall stops the body flush against its face, not 0.2 short', () => {
  const m = floorMap(7);
  for (let y = 7; y < 12; y++) for (let z = -4; z <= 4; z++) m.set(`5,${y},${z}`, C_FULL);
  const cell = mkWorld(m);
  const p = newPlayer(0, 7, 0);
  run(p, { fx: 1, fz: 0 }, 2, cell);
  assert.ok(p.x < 5, 'never inside the wall');
  assert.ok(Math.abs(p.x - (5 - BODY.w / 2)) < 1e-3, `flush against the wall, got x=${p.x}`);
  assert.equal(p.y, 7, 'a wall does not launch you upward');
});

test('a full block in the path is not climbed - you have to jump', () => {
  const m = floorMap(7);
  for (let z = -2; z <= 2; z++) m.set(`4,7,${z}`, C_FULL);
  const cell = mkWorld(m);
  const p = newPlayer(0, 7, 0);
  run(p, { fx: 1, fz: 0 }, 2, cell);
  assert.ok(p.x < 4, `stopped in front of it (x=${p.x})`);
  assert.equal(p.y, 7, 'no auto-climb of a whole block');
});

test('jumping gets you on top of a block, and you come back down past it', () => {
  const m = floorMap(7);
  for (let z = -2; z <= 2; z++) m.set(`3,7,${z}`, C_FULL);
  const cell = mkWorld(m);
  const p = newPlayer(1.8, 7, 0);
  // jump at the moment a player would: just before the wall
  let onTop = 0, peak = 7;
  for (let t = 0; t < 2; t += 1 / 60) {
    simulate(p, { fx: 1, fz: 0, jump: t < 1 / 60 }, 1 / 60, cell);
    if (p.y === 8 && p.onGround) onTop = 1;
    peak = Math.max(peak, p.y);
  }
  assert.equal(onTop, 1, 'stood on top of the block');
  assert.ok(peak > 8 && peak < 8.5, `rose just enough to get up there (peak ${peak})`);
  assert.ok(p.x > 3, `came down on the far side, x=${p.x}`);
  assert.equal(p.y, 7, 'and walked on along the floor');
});

test('a 2-block-high wall cannot be jumped, and you land back where you started', () => {
  const m = floorMap(7);
  for (let z = -2; z <= 2; z++) for (let x = 3; x <= 6; x++) { m.set(`${x},7,${z}`, C_FULL); m.set(`${x},8,${z}`, C_FULL); }
  const cell = mkWorld(m);
  const p = newPlayer(1.8, 7, 0);
  let peak = 7;
  for (let t = 0; t < 2.5; t += 1 / 60) {
    simulate(p, { fx: 1, fz: 0, jump: t < 1 / 60 }, 1 / 60, cell);
    peak = Math.max(peak, p.y);
  }
  assert.ok(p.x < 3, `still in front of it (x=${p.x})`);
  assert.ok(peak < 8.4, `a jump does not clear two blocks (peak ${peak})`);
  assert.equal(p.y, 7);
});

test('a jump clears about one block, and lands back down', () => {
  const cell = mkWorld(floorMap(7));
  const p = newPlayer(0, 7, 0);
  let peak = 7;
  for (let t = 0; t < 1.5; t += 1 / 60) {
    simulate(p, { jump: t < 1 / 60 }, 1 / 60, cell);
    peak = Math.max(peak, p.y);
  }
  assert.ok(peak > 8 - 0.05 && peak < 8.6, `clearance ${peak - 7} blocks`);
  assert.equal(p.y, 7, 'back on the floor');
});

test('a half slab is stepped up without jumping, and stepped back down', () => {
  const m = floorMap(7);
  for (let z = -2; z <= 2; z++) m.set(`3,7,${z}`, 8);        // 8/16 tall
  const cell = mkWorld(m);
  const p = newPlayer(1.8, 7, 0);
  let onSlab = 0, peak = 7;
  for (let t = 0; t < 2; t += 1 / 60) {
    simulate(p, { fx: 1, fz: 0 }, 1 / 60, cell);
    if (p.y === 7.5 && p.onGround) onSlab = 1;
    peak = Math.max(peak, p.y);
  }
  assert.equal(onSlab, 1, 'walked up onto the slab');
  assert.ok(peak <= 7 + STEP_UP + 1e-6, `the step-up never climbed higher than STEP_UP (${peak})`);
  assert.ok(p.x > 3, `and walked off the other side, x=${p.x}`);
  assert.equal(p.y, 7, 'back on the floor');
});

test('a 40 blocks/s fall never passes through the floor, even at a hitched frame time', () => {
  const cell = mkWorld(floorMap(7));
  const p = newPlayer(0, 120, 0);
  let minY = Infinity;
  for (let t = 0; t < 12; t += 1 / 60) {
    simulate(p, {}, 0.1, cell);            // 10 fps: fixed substeps must still catch the floor
    minY = Math.min(minY, p.y);
  }
  assert.ok(minY >= 7, `never below the floor (min ${minY})`);
  assert.equal(p.y, 7);
  assert.ok(p.vy === 0);
});

test('an unloaded column freezes the body instead of dropping it through the world', () => {
  // Everything at y <= 10 has no data yet.
  const cell = mkWorld(floorMap(7), (x, y, z) => y <= 10);
  const p = newPlayer(0, 20, 0);
  const ev = run(p, {}, 2, cell);
  assert.ok(p.frozen, 'says it is waiting for voxels');
  assert.ok(p.y > 10, `held above the unknown space (y=${p.y})`);
  assert.ok(ev.some((e) => e.frozen));
  // ... and it starts moving again as soon as the data arrives
  const cell2 = mkWorld(floorMap(7));
  p.frozen = 0;
  run(p, {}, 1, cell2);
  assert.ok(p.y < 20, 'falls again once the voxels are there');
});

test('the bottom of the world is a floor, not an endless fall', () => {
  const cell = mkWorld(new Map());                  // pure void
  const p = newPlayer(0, 0, 0);
  for (let t = 0; t < 30; t += 0.1) simulate(p, {}, 0.1, cell, { minY: -64 });
  assert.equal(p.y, -64);
  assert.equal(p.onGround, 1);
  assert.ok(Math.abs(p.vy) < 1e-9);
});

test('fall speed is capped', () => {
  const p = newPlayer(0, 0, 0);
  for (let t = 0; t < 5; t += 0.05) simulate(p, {}, 0.05, mkWorld(new Map()));
  assert.ok(-p.vy <= FALL_MAX + 1e-6, `vy ${p.vy}`);
});

test('a ladder is climbed with space and does not drop you', () => {
  const m = floorMap(7);
  for (let y = 7; y < 20; y++) m.set(`0,${y},0`, C_CLIMB);
  const cell = mkWorld(m);
  const p = newPlayer(0, 7, 0);
  run(p, {}, 1, cell);
  assert.equal(p.climbing, 1);
  assert.ok(Math.abs(p.y - 7) < 1e-6, `hanging on the ladder (y=${p.y})`);
  run(p, { jump: 1 }, 1, cell);
  assert.ok(p.y > 7 + CLIMB_V * 0.7, `climbed to ${p.y}`);
  run(p, { down: 1 }, 1, cell);
  assert.ok(p.y < 10, 'and back down');
});

test('water is swim, not fall: you bob up with space and sink slowly without it', () => {
  const m = new Map();
  for (let y = 0; y < 20; y++) for (let x = -2; x <= 2; x++) m.set(`${x},${y},0`, C_LIQUID);
  const cell = mkWorld(m);
  const p = newPlayer(0, 10, 0);
  run(p, {}, 1, cell);
  assert.equal(p.inWater, 1);
  assert.ok(p.vy < 0 && -p.vy < FALL_MAX / 4, `sinks slowly (vy=${p.vy.toFixed(2)})`);
  const y0 = p.y;
  run(p, { jump: 1 }, 1, cell);
  assert.ok(p.y > y0, 'and rises on space');
});

test('free flight ignores gravity and walls', () => {
  const m = floorMap(7);
  for (let y = 7; y < 12; y++) for (let z = -4; z <= 4; z++) m.set(`5,${y},${z}`, C_FULL);
  const cell = mkWorld(m);
  const p = newPlayer(0, 7, 0);
  run(p, { fx: 1, fz: 0, fly: 1 }, 1, cell);
  assert.ok(p.x > 5, 'walks through the wall, which is the point of flight');
  run(p, { down: 1, fly: 1 }, 1, cell);
  assert.ok(p.y < 7, 'and descends on Shift');
});

test('a diagonal is not faster than a straight line', () => {
  const cell = mkWorld(floorMap(7));
  const a = newPlayer(0, 7, 0); const b = newPlayer(0, 7, 0);
  const s = Math.SQRT1_2;
  run(a, { fx: 1, fz: 0 }, 1, cell);
  run(b, { fx: s, fz: s }, 1, cell);
  assert.ok(Math.abs(Math.hypot(b.x, b.z) - Math.abs(a.x)) < 1e-6, 'same ground speed');
});

test('sprint multiplies speed by the game ratio', () => {
  const cell = mkWorld(floorMap(7));
  const a = newPlayer(0, 7, 0); const b = newPlayer(0, 7, 0);
  run(a, { fx: 1, fz: 0 }, 1, cell);
  run(b, { fx: 1, fz: 0, sprint: 1 }, 1, cell);
  assert.ok(Math.abs(a.x - WALK) < 0.15, `walk ${a.x}`);
  assert.ok(Math.abs(b.x - SPRINT) < 0.2, `sprint ${b.x}`);
});

test('a hitched frame cannot simulate more than its clamp', () => {
  const cell = mkWorld(floorMap(7));
  const p = newPlayer(0, 7, 0);
  const ev = simulate(p, { fx: 1, fz: 0, fly: 1 }, 5, cell);
  assert.ok(ev.substeps <= 30, `substeps ${ev.substeps}`);
  assert.ok(Math.abs(p.x) < 5 * WALK, 'no five-second teleport');
});

test('place() lifts a body out of rock and onto the floor', () => {
  const m = floorMap(7);
  m.set('0,20,0', C_FULL); m.set('0,21,0', C_FULL);      // the goto landed inside a wall
  const cell = mkWorld(m);
  const p = newPlayer(9, 9, 9);
  assert.equal(place(cell, p, 0, 20, 0), 22, 'rose above the wall');
  assert.equal(p.y, 22);
  const q = newPlayer(0, 0, 0);
  place(cell, q, 3, 30, 3, { maxDrop: 40 });             // a clear column, dropped from high up
  assert.equal(q.y, 7, 'and fell to the floor');
  const w = newPlayer(0, 0, 0);
  place(cell, w, 0, 30, 0, { maxDrop: 40 });             // the wall is a pillar: you stand on it
  assert.equal(w.y, 22, 'never through the pillar');
  const unknown = mkWorld(floorMap(7), (x, y, z) => y > 8);
  const r = newPlayer(3, 3, 3);
  assert.ok(Number.isNaN(place(unknown, r, 0, 20, 0)));
  assert.deepEqual([r.x, r.y, r.z], [3, 3, 3], 'an unknown place does not move the body');
});

test('the collision rule: stairs block, plants do not, unknown modded blocks do', () => {
  assert.equal(bodyRule('minecraft:oak_stairs|facing=north'), C_FULL);
  assert.equal(bodyRule('minecraft:stone_brick_wall|up=true'), C_FULL);
  assert.equal(bodyRule('minecraft:oak_fence|north=true'), C_FULL);
  assert.equal(bodyRule('minecraft:oak_door|hinge=lower,open=false'), C_FULL);
  assert.equal(bodyRule('beautify:hanging_pot'), C_FULL);
  assert.equal(bodyRule('minecraft:torch'), 0);
  assert.equal(bodyRule('minecraft:oak_sign|rotation=4'), 0);
  assert.equal(bodyRule('minecraft:rail|shape=north_south'), 0);
  assert.equal(bodyRule('minecraft:fire|age=3'), 0);
  assert.equal(bodyRule('minecraft:cave_vines|age=3'), C_CLIMB);
  assert.equal(bodyRule('minecraft:ladder'), C_CLIMB);
  assert.equal(bodyRule('minecraft:glow_lichen|up=true'), 0);
});

test('the collision table carries model heights, films and air', () => {
  const states = [
    { k: 'minecraft:air' },
    { k: 'minecraft:grass_block' },
    { k: 'minecraft:stone_slab' },
    { k: 'minecraft:water' },
    { k: 'minecraft:ladder' },
    { k: 'minecraft:oak_leaves' },
  ];
  const air = Uint8Array.from([1, 0, 0, 0, 0, 0]);
  const film = Uint8Array.from([0, 0, 0, 1, 0, 0]);
  const height = Uint8Array.from([0, 16, 8, 16, 16, 16]);
  const t = collisionTable(states, air, film, height);
  assert.equal(t[0], 0, 'air: nothing to hit');
  assert.equal(t[1], C_FULL);
  assert.equal(t[2], 8, 'a slab is half a block tall');
  assert.equal(t[3] & C_LIQUID, C_LIQUID, 'water is swimmable');
  assert.equal(t[3] & 31, 0, 'and never blocks');
  assert.equal(t[4] & C_CLIMB, C_CLIMB);
  assert.equal(t[5], C_FULL, 'leaves you can stand on');
});

test('the shape of a state decides too: all-vertical quads are a plant, a top face is not', () => {
  // Model units, one quad = 4 corners x xyz, y at 1,4,7,10.
  const QUADS = [
    [0, 0, 8, 16, 16, 8, 16, 0, 8, 0, 16, 8],       // a vertical plane across the cell
    [8, 0, 0, 8, 16, 16, 8, 0, 16, 8, 16, 0],       // another one at right angles: a grass tuft
    [4, 0, 4, 4, 15, 4, 12, 15, 4, 12, 0, 4],       // a fence post side
    [4, 15, 4, 4, 15, 12, 12, 15, 12, 12, 15, 4],   // the post's top: one flat quad
  ];
  const flat = (gi) => {
    const q = QUADS[gi];
    return q[1] === q[4] && q[1] === q[7] && q[1] === q[10];
  };
  const states = [
    { k: 'somemod:grass_tuft', q: [0, 1] },          // a name no list knows, 16 units tall
    { k: 'somemod:fence_post', q: [2, 3] },          // vertical sides, but it has a top
    { k: 'somemod:bake_produced_nothing', q: [] },   // unknown shape: stay conservative
    { k: 'minecraft:dirt', cube: [[0, 0, 0, 0, 0, 0]] },
  ];
  const geomsOf = (s) => s.q ?? [];
  assert.equal(bodyRule('somemod:grass_tuft'), C_FULL, 'the NAME says block: the pass must come from shape');
  const foot = stateFootprints(states, geomsOf, flat);
  assert.deepEqual([...foot], [F_THIN, F_FLAT, F_NONE, F_FLAT],
    'the tuft is all vertical, the post has a top, the empty bake is unknown, the cube is a cube');
  const height = stateHeights(states, geomsOf, (gi) => Math.max(...[1, 4, 7, 10].map((k) => QUADS[gi][k])));
  const t = collisionTable(states, Uint8Array.from([0, 0, 0, 0]), Uint8Array.from([0, 0, 0, 0]), height, foot);
  assert.equal(t[0], 0, 'you walk through a plant that reaches the top of its cell');
  assert.equal(t[1], 15, 'a post with a top face stops you, at the height its own geometry reaches');
  assert.equal(t[2], C_FULL, 'a state with no baked shape at all is not assumed walkable');
  assert.equal(t[3], C_FULL, 'and a cube is a cube');
  assert.equal(collisionTable(states, null, null, height)[0], C_FULL,
    'without the footprint argument the old table blocks the tuft: this is the bug the shape fixes');
});

test('constants match the game, and the numbers a probe will quote', () => {
  assert.equal(BODY.eye, 1.62);
  assert.ok(BODY.h > BODY.eye, 'the crown is above the eye');
  assert.ok(Math.abs(GRAVITY - 32) < 1e-9);
  assert.ok(Math.abs(JUMP_V - 8.4) < 1e-9);
  assert.ok(1 / TICK >= 60, 'the fixed substep is finer than a frame');
  // v^2 / 2g is the clearance a jump buys
  assert.ok((JUMP_V * JUMP_V) / (2 * GRAVITY) > 1.0, 'a jump clears a block');
});

// Leaving free flight can put the body inside a mountain, and a collision resolver will not push a body
// out of solid rock: every move is refused, and the viewer has a statue. So the mode switch itself asks
// the world for the first clear position at or below where flight left the body.
test('free flight that ends inside a mountain puts the body on the ground under it', () => {
  const m = new Map();
  for (let y = 10; y <= 30; y++) for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) m.set(`${x},${y},${z}`, C_FULL);
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) m.set(`${x},4,${z}`, C_FULL);   // floor, top face 5
  const cell = mkWorld(m);
  const p = newPlayer(0, 20, 0);                 // where flight left it: inside the rock
  assert.notEqual(hits(cell, p.x, p.y, p.z), 0, 'the body really is inside the rock');
  const y = dropToClear(cell, p);
  assert.ok(Number.isFinite(y), 'the world answered');
  assert.ok(y < 20 && y >= 8, `it went down to the first clear box under the roof: ${y}`);
  assert.equal(hits(cell, p.x, y, p.z), 0, 'the new position is clear');
  run(p, {}, 2, cell, {});
  assert.equal(p.y, 5, `the feet end on the floor under it: ${p.y}`);
  assert.equal(p.onGround, 1);
  // Unknown voxels are not guessed at; the caller waits for the bytes.
  const unknown = mkWorld(new Map(), (x) => x > 100);
  assert.ok(Number.isNaN(dropToClear(unknown, newPlayer(200, 20, 0))), 'unknown means wait, not guess');
});
