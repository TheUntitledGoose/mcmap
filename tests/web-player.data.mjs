// The walking body against real region bytes: the payload reader, the asset pack's collision table and
// the physics, end to end. The oracle is the column dump:
//
//   node tools/column.mjs --cx 127 --cz 169 --x 10 --z 14 --y1 150 --y0 -60
//     y  73 .. 72  regions_unexplored:orange_maple_leaves      the canopy, top face 74
//     y  68 .. 68  regions_unexplored:silt_grass_block         a floor whose top face is 69
//     y  33 .. 31  minecraft:stone                             the cavern roof
//     y  30 .. 13  minecraft:air                               18 blocks of cave air
//     y  12 ..  6  minecraft:stone                             the cavern floor, top face 13
//     y -35 .. -60 minecraft:deepslate                         unbroken to the bottom of the world
//
// If any of the three layers (payload, asset table, physics) drifts, this stops matching the dump.
// Run tools/column.mjs on the same coordinates when it fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { BODY, C_CLIMB, C_FULL, C_LIQUID, C_PASS, C_UNKNOWN, blocks, bodyRule, hits, liquid,
  floorTop, h16Of, newPlayer, place, simulate } from '../shared/player.mjs';

const CX = 127, CZ = 169, LX = 10, LZ = 14;        // world (2042, 2718)
const WX = CX * 16 + LX, WZ = CZ * 16 + LZ;
const OPT = { minY: -64 };

function load() {
  if (load.cached) return load.cached;
  const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
  const geo = fs.readFileSync('build/assets/geometry.bin');
  const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
  load.cached = { json, assets };
  return load.cached;
}

let surfaceCached = null;
async function surface() {
  if (surfaceCached) return surfaceCached;
  const { json, assets } = load();
  const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
  const held = new Map();
  for (let cx = 11; cx <= 13; cx++) {
    for (let cz = 9; cz <= 11; cz++) {
      const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
      if (!buf) continue;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (!held.has(cx)) held.set(cx, new Map());
      held.get(cx).set(cz, openChunk(ab, 0));
    }
  }
  surfaceCached = { cellAt: makeCellAt((cx, cz) => (held.get(cx)?.get(cz)) || null, () => assets) };
  return surfaceCached;
}

let cached = null;
async function column() {
  if (cached) return cached;
  const { json, assets } = load();
  const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)),
    'build/cache', {});
  // Hold a 3x3 neighbourhood, as the browser would, so a walk does not run off the edge of the known
  // world halfway through.
  const held = new Map();
  for (let cx = CX - 1; cx <= CX + 1; cx++) {
    for (let cz = CZ - 1; cz <= CZ + 1; cz++) {
      const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
      if (!buf) continue;                                // a region slot with no chunk in it
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (!held.has(cx)) held.set(cx, new Map());
      held.get(cx).set(cz, openChunk(ab, 0));
    }
  }
  const chunk = held.get(CX).get(CZ);
  const at = (x, y, z) => {
    const c = held.get(x >> 4)?.get(z >> 4);
    if (!c) return C_UNKNOWN;
    const s16 = y >> 4;                                  // payload yMin/yCount count SECTIONS, not blocks
    if (s16 < c.yMin) return C_FULL;
    if (s16 >= c.yMin + c.yCount) return C_PASS;
    if (!c.sectionAt(y)) return C_PASS;                  // a section the writer left out is all air
    return assets.collisionOf(c.stateAt(x & 15, y, z & 15));
  };
  const cellAt = makeCellAt((cx, cz) => (held.get(cx)?.get(cz)) || null, () => assets);
  cached = { assets, json, chunk, cellAt, at };
  return cached;
}

test('the column the world stores is the column the physics feels', async () => {
  const { at, cellAt, chunk } = await column();
  assert.ok(chunk, 'the chunk must be held for this test to mean anything');
  assert.equal(at(WX, 74, WZ), C_PASS, 'air above the canopy');
  assert.ok(blocks(at(WX, 73, WZ)) && h16Of(at(WX, 73, WZ)) === 16, 'the canopy is a full block at 73, so its top face is 74');
  assert.equal(at(WX, 70, WZ), C_PASS, 'air between canopy and ground');
  assert.ok(blocks(at(WX, 68, WZ)) && h16Of(at(WX, 68, WZ)) === 16, 'silt grass is a floor with its top face at 69');
  assert.ok(blocks(at(WX, 66, WZ)), 'silt dirt blocks');
  assert.ok(blocks(at(WX, 50, WZ)), 'stone blocks');
  assert.ok(blocks(at(WX, 40, WZ)), 'diorite blocks');
  assert.equal(at(WX, 20, WZ), C_PASS, 'the cave is air');
  assert.ok(blocks(at(WX, 12, WZ)) && h16Of(at(WX, 12, WZ)) === 16, 'the cavern floor is a full block at 12, so its top face is 13');
  assert.ok(blocks(at(WX, -50, WZ)), 'deepslate at the bottom of the world blocks');
  // floorTop answers where the feet belong *at* a position: the world heights of the top faces, and 0
  // for clear air. These are the numbers the column dump gives for this column.
  assert.equal(floorTop(cellAt, WX + 0.5, 13, WZ + 0.5), 13, 'in the cavern the feet belong at 13');
  assert.equal(floorTop(cellAt, WX + 0.5, 69, WZ + 0.5), 69, 'under the grass, at 69');
  assert.equal(floorTop(cellAt, WX + 0.5, 74, WZ + 0.5), 74, 'and on top of the canopy, at 74');
  assert.equal(floorTop(cellAt, WX + 0.5, 20, WZ + 0.5), 0, 'mid-air is not a floor');
});

test('a chunk the browser does not hold is unknown, and below the stored range is rock', async () => {
  const { cellAt, chunk } = await column();
  assert.equal(cellAt(4000, 0, 4000), C_UNKNOWN, 'not held, so nothing may be assumed about it');
  assert.equal(cellAt(WX, (chunk.yMin - 1) * 16, WZ), C_FULL, 'below every stored section is the world floor');
  assert.equal(cellAt(WX, (chunk.yMin + chunk.yCount) * 16, WZ), C_PASS, 'above it is sky');
});

test('a body released in the cave stands on the cave floor', async () => {
  const { cellAt } = await column();
  const p = newPlayer(WX + 0.5, 20, WZ + 0.5);
  let frames = 0;
  while (!p.onGround && frames < 600) { simulate(p, {}, 1 / 60, cellAt, OPT); frames++; }
  assert.equal(p.y, 13, 'feet on the top face of the stone at 12');
  assert.ok(p.onGround, 'and it knows it');
  assert.ok(frames > 20 && frames < 120, `took ${frames} frames at 60 Hz, about one second of fall`);
  assert.ok(Math.abs((p.y + BODY.eye) - 14.62) < 1e-9, 'the eye is 1.62 above the feet');
});

test('a body released at the canopy stops at the canopy, not under it', async () => {
  const { cellAt } = await column();
  const p = newPlayer(WX + 0.5, 80, WZ + 0.5);
  let frames = 0;
  while (!p.onGround && frames < 900) { simulate(p, {}, 1 / 60, cellAt, OPT); frames++; }
  assert.equal(p.y, 74, 'the leaves hold at their top face');
  assert.ok(Math.abs(p.vy) < 1e-9, 'and it comes to rest there');
});

test('no frame of a real fall hovers or freezes', async () => {
  const { cellAt } = await column();
  const p = newPlayer(WX + 0.5, 66, WZ + 0.5);           // inside ground: falls through the cave
  let hover = 0, frozen = 0, prev = p.y;
  for (let i = 0; i < 120; i++) {
    const ev = simulate(p, {}, 1 / 60, cellAt, OPT);
    if (ev.frozen) frozen++;
    if (Math.abs(p.vy) > 1 && Math.abs(p.y - prev) < 1e-6 && !p.onGround) hover++;
    prev = p.y;
  }
  assert.equal(hover, 0, 'a frame with speed and no movement is the mid-air stop, seen as a number');
  assert.equal(frozen, 0, 'the whole column is held, so nothing here is unknowable');
  assert.ok(p.onGround, 'and it ends up standing');
});

test('when the cavern floor drops away the body drops with it', async () => {
  const { cellAt } = await column();
  const p = newPlayer(WX + 0.5, 20, WZ + 0.5);
  let settle = 0;
  while (!p.onGround && settle < 600) { simulate(p, {}, 1 / 60, cellAt, OPT); settle++; }
  assert.equal(p.y, 13, 'start on the cavern floor under the spawn column');
  let air = 0, min = 13, inRock = 0, frozen = 0;
  for (let i = 0; i < 180; i++) {                        // 3 s sprinting east
    const ev = simulate(p, { fx: 1, fz: 0, sprint: 1 }, 1 / 60, cellAt, OPT);
    if (!p.onGround) air++;
    if (ev.frozen) frozen++;
    min = Math.min(min, p.y);
    if (hits(cellAt, p.x, p.y, p.z)) inRock++;
  }
  // East of the spawn column the cavern steps down and then falls a long way into the caves under the
  // hill. Measured here: 15.2 blocks covered, feet down to -11, standing on something at the end. The
  // old camera snap refused to travel into terrain like this; a body follows it, and the view depth
  // grows downward to match (walkWant's descend term).
  assert.ok(p.x > WX + 14, `it sprinted, to x ${p.x.toFixed(2)} in 3 s`);
  assert.ok(min <= -8, `the cavern drops away and the body came with it, down to ${min.toFixed(2)}`);
  assert.ok(p.onGround, `and it stopped on a floor, at ${p.y.toFixed(2)}`);
  assert.equal(inRock, 0, 'never once inside a solid cell');
  assert.equal(frozen, 0, 'the held 3x3 stayed loaded under its feet the whole way');
  assert.ok(air > 100, `most of those frames were air on the way down: ${air} of 180`);
});

test('walking slowly on level stone stays on level stone', async () => {
  const { cellAt } = await column();
  const p = newPlayer(WX + 0.5, 25, WZ + 0.5);
  let settle = 0;
  while (!p.onGround && settle < 600) { simulate(p, {}, 1 / 60, cellAt, OPT); settle++; }
  assert.equal(p.y, 13);
  let air = 0, inRock = 0;
  for (let i = 0; i < 60; i++) {                         // 1 s at a crawl: 0.18 blocks
    simulate(p, { fx: 0.18, fz: 0 }, 1 / 60, cellAt, OPT);
    if (!p.onGround) air++;
    if (hits(cellAt, p.x, p.y, p.z)) inRock++;
  }
  assert.ok(p.x > WX + 0.6, `crawled to ${p.x.toFixed(2)} at 0.18 blocks/s`);
  assert.equal(p.y, 13, 'the floor it started on runs at least a block east from here');
  assert.equal(air, 0, 'a slow walker on flat stone never leaves the floor');
  assert.equal(inRock, 0, 'and never ends up inside a wall');
});

test('a body put inside rock climbs out of it, and one dropped in the void finds the floor', async () => {
  const { cellAt, at } = await column();
  assert.ok(blocks(at(WX, 40, WZ)) && blocks(at(WX, 41, WZ)), 'the test column really is rock at 40');
  const inRock = newPlayer(WX + 0.5, 66, WZ + 0.5);      // silt_dirt at 66, silt_grass at 68
  const y1 = place(cellAt, inRock, WX + 0.5, 66, WZ + 0.5, { maxRise: 4, maxDrop: 12 });
  assert.ok(Number.isFinite(y1), 'the column is held, so placing must answer');
  assert.ok(y1 >= 69, `out of the rock and onto the silt floor, got ${y1}`);
  const inVoid = newPlayer(WX + 0.5, 25, WZ + 0.5);      // cavern air: roof above, floor at 13
  assert.equal(place(cellAt, inVoid, WX + 0.5, 25, WZ + 0.5, { maxRise: 4, maxDrop: 60 }), 13,
    'the roof of the cavern is not a floor - the floor is');
  const buried = newPlayer(WX + 0.5, 40, WZ + 0.5);      // inside diorite, deeper than the rise budget
  assert.ok(Number.isNaN(place(cellAt, buried, WX + 0.5, 40, WZ + 0.5, { maxRise: 4, maxDrop: 40 })),
    'rock it cannot get out of is refused rather than guessed at');
});

test('a grass tuft from a mod is walked through, and the leaves above it are not', async () => {
  // The browser probe found this by stopping dead 6 blocks east of where the Node harness said the
  // ground was clear. tools/column.mjs on the same spot says why:
  //   node tools/column.mjs --cx 12 --cz 10 --x 8 --z 1 --y1 74 --y0 64
  //     y  71 ..  70  regions_unexplored:mauve_leaves      solid: leaves you can stand on
  //     y      67     regions_unexplored:medium_grass      a ground cover, and it was a WALL
  // A name list cannot know every mod's plant names, so the rule is geometric: no horizontal quad.
  const { cellAt } = await surface();
  const X = 200, Z = 161;
  assert.equal(cellAt(X, 67, Z), 0, 'the tuft at foot height is walk-through');
  assert.ok(blocks(cellAt(X, 70, Z)) && blocks(cellAt(X, 71, Z)), 'the leaves are solid');
  const b = newPlayer(X - 3.5, 67, Z + 0.5);
  assert.equal(place(cellAt, b, X - 3.5, 67, Z + 0.5, { maxRise: 3, maxDrop: 8 }), 67, 'stood on the grass');
  for (let i = 0; i < 120; i++) {
    simulate(b, { fx: 1, fz: 0 }, 1 / 60, cellAt, { minY: -64 });   // sprint east into the tuft
  }
  assert.ok(b.x > X + 1.5, `walked through the tuft to x ${b.x.toFixed(2)}, not stopped by it`);
  assert.equal(Math.round(b.y), 67, 'and still on the same ground');
});

test('the asset pack knows what it baked: named blocks get a sane rule', async () => {
  const { assets, json } = load();
  const ruleFor = (name) => {
    for (let i = 0; i < json.states.length; i++) {
      if (json.states[i].k.split('|')[0] === `minecraft:${name}`) return assets.stateCollision[i];
    }
    return null;                                        // this save has no such block
  };
  const say = (what, got) => `${what}: got ${got}`;
  const stone = ruleFor('stone');
  if (stone !== null) assert.equal(stone, C_FULL, say('stone', stone));
  const air = ruleFor('air');
  if (air !== null) assert.equal(air, C_PASS, say('air', air));
  const water = ruleFor('water');
  if (water !== null) assert.equal(water, C_LIQUID, say('water', water));
  const ladder = ruleFor('ladder');
  if (ladder !== null) assert.equal(ladder, C_CLIMB, say('ladder', ladder));
  const grass = ruleFor('tall_grass');
  if (grass !== null) assert.equal(h16Of(grass), 0, say('tall_grass is walk-through', grass));
  // A full cube blocks whatever its name, because the mesher and the body must agree about the rock.
  // Lava is the one place where "opaque full cube" and "solid" come apart: it fills the renderer's
  // space and the body moves through it, so it has to come out as a liquid, not a floor.
  for (let i = 0; i < json.states.length && i < 400; i++) {
    if (assets.stateCube[i] && !assets.stateAir[i] && !assets.stateFilm[i]
        && bodyRule(json.states[i].k) === C_FULL) {
      assert.ok(blocks(assets.stateCollision[i]),
        `cube ${json.states[i].k} must block the body, got ${assets.stateCollision[i]}`);
    }
  }
  for (const nm of ['minecraft:lava|level=0', 'minecraft:water|level=0']) {
    const i = json.states.findIndex((s) => s.k === nm);
    if (i < 0) continue;
    assert.ok(liquid(assets.stateCollision[i]), `${nm} must be swum in, not stood on or walked through`);
  }
  for (const k of ['regions_unexplored:silt_grass_block', 'regions_unexplored:stone_slab']) {
    const i = json.states.findIndex((s) => s.k.startsWith(k));
    if (i < 0) continue;
    const v = assets.stateCollision[i];
    assert.ok(blocks(v), `${k} must be stood on, got ${v}`);
    assert.ok(h16Of(v) > 0, `${k} has a top face above its cell floor`);
  }
});

test('an unknown column freezes the body instead of dropping it, and flight does not care', async () => {
  const { cellAt } = await column();
  const p = newPlayer(4000.5, 100, 4000.5);              // a chunk nothing serves
  for (let i = 0; i < 120; i++) simulate(p, { fx: 1, fz: 1 }, 1 / 60, cellAt, OPT);
  assert.equal(p.y, 100, 'an unknown column is not a shaft: no fall, no walk');
  assert.equal(p.x, 4000.5, 'sideways too');
  assert.equal(p.frozen, 1, 'and it is reported, so the HUD can say why nothing is happening');
  for (let i = 0; i < 120; i++) simulate(p, { fx: 1, fz: 1, fly: 1 }, 1 / 60, cellAt, OPT);
  assert.ok(p.x > 4010 && p.y === 100, 'a spectator flies straight through it');
});
