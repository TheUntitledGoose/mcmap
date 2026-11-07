// A player body, not a camera trick: an axis-aligned box that stands on voxels, falls, jumps,
// climbs ladders, swims, and cannot walk through rock.
//
// No DOM and no three.js in here on purpose, so the whole body is unit-tested (tests/player.test.mjs)
// against synthetic voxel worlds. The page owns the voxel lookup and the camera; this owns the body.
//
// Position convention: p.y is the **feet**, not the eye. The eye is `p.y + BODY.eye` (1.62), which is
// the game's convention, and it is what makes standing, stepping and landing read correctly.
//
// The voxel answer is one packed byte per cell, because the save stores no collision boxes:
//   -1                     no data for that cell yet (unloaded chunk, missing section)
//    0                     nothing to hit (air, plants, torches, water)
//    1..16                how tall the obstacle is inside that cell, in sixteenths of a block:
//                         16 a full cube, 8 a half slab, 1 a carpet
//   | 32                   climbable (a ladder)
//   | 64                   liquid (swimmable, never blocking)
// The heights come from the baked model geometry (assets.js), which is why a slab you can step up and
// a full block you have to jump are different things without inventing a block shape table by hand.

export const BODY = { w: 0.6, h: 1.8, eye: 1.62 };

// Minecraft's own numbers where they are knowable: gravity is 0.08 blocks/tick^2 at 20 ticks/s = 32
// blocks/s^2; a jump starts at 0.42 blocks/tick = 8.4 blocks/s, i.e. 1.1-1.25 blocks of clearance;
// a player walks 4.317 blocks/s and sprints 5.613.
export const GRAVITY = 32;
export const JUMP_V = 8.4;
export const STEP_UP = 0.62;      // auto-climb: slab, carpet, bed, stair nosing - never a full block
export const WALK = 4.317;
export const SPRINT = 5.613;
export const SNEAK = 1.3;
export const FLY_V = 22;          // free flight: no gravity, no collision
export const CLIMB_V = 3.0;       // ladders
export const SWIM_V = 3.5;        // holding space in water
export const FALL_MAX = 40;       // terminal speed; the game allows ~78 and hurts you for it
export const TICK = 1 / 120;      // fixed substep, so a frame hitch cannot tunnel a floor
export const MAX_FRAME_DT = 0.2;  // never simulate more than this much hitch in one frame

export const C_UNKNOWN = -1;
export const C_PASS = 0;
export const C_FULL = 16;
export const C_CLIMB = 32;
export const C_LIQUID = 64;

export const h16Of = (v) => v & 31;
export const blocks = (v) => (v & 31) > 0;
export const climbs = (v) => (v & C_CLIMB) !== 0;
export const liquid = (v) => (v & C_LIQUID) !== 0;

// ------------------------------------------------------------- which states block a body
// Everything that is not air and not a cube is decided by name, because that group is two obvious
// families: stairs, walls, fences, doors, panes and bars, which you cannot walk through; and plants,
// torches, signs, rails and carpets, which you can. Unknown modded shapes default to blocking - an
// invisible wall you walk into is a worse surprise than being held up by a flower pot, and `?view=fly`
// is the escape hatch.
const PASS_NAMES = new Set([
  'bubble_column', 'fire', 'soul_fire', 'redstone_wire', 'sculk_vein', 'glow_lichen',
  'cobweb', 'snow', 'cactus', 'bamboo', 'sugar_cane', 'kelp', 'kelp_plant',
  'seagrass', 'tall_seagrass', 'grass', 'short_grass', 'fern', 'large_fern', 'tall_grass', 'dead_bush',
  'vine', 'nether_sprouts', 'spore_blossom', 'pink_petals', 'lever', 'tripwire', 'tripwire_hook',
  'chain', 'moss_carpet', 'pale_hanging_moss', 'open_eyes', 'sculk_sensor', 'calibrated_sculk_sensor',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'torchflower_crop', 'pitcher_crop', 'sweet_berry_bush',
  'torch', 'rail', 'end_rod', 'sea_pickle', 'turtle_egg', 'dragon_egg', 'frogspawn', 'sniffer_egg',
  'cave_vines', 'cave_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'weeping_vines',
  'weeping_vines_plant', 'lily_pad', 'crimson_roots', 'warped_roots', 'nether_wart', 'chorus_plant',
  'chorus_flower', 'hanging_roots', 'pitcher_plant', 'big_dripleaf_stem', 'small_dripleaf',
]);
const PASS_SUFFIX = [
  '_vine', '_vines', '_torch', '_candle', '_cake', '_sign', '_hanging_sign', '_banner',
  '_item_frame', '_pressure_plate', '_button', '_carpet', '_sapling', '_flower', '_rail',
  '_lichen', '_crop', '_sprouts', '_bud', '_cluster', '_head', '_roots', '_eyes', '_torch',
];
const CLIMB_NAMES = new Set(['ladder', 'vine', 'cave_vines', 'cave_vines_plant', 'twisting_vines',
  'weeping_vines', 'scaffolding']);
// Water is already a "film" to the mesher, so it arrives as liquid without help. Lava does not: it is
// an opaque full cube to the renderer, and calling it passable would let a walker stand and breathe at
// the bottom of a lava lake. It is a liquid you swim in.
const LIQUID_NAMES = new Set(['water', 'lava', 'lava_flow', 'bubble_column']);

/** The rule for one state key, ignoring height: collision flags plus "blocking or not". */
export function bodyRule(key) {
  const bare = key.split('|')[0];
  const name = (bare.includes(':') ? bare.split(':')[1] : bare).toLowerCase();
  if (LIQUID_NAMES.has(name)) return C_LIQUID;
  if (CLIMB_NAMES.has(name)) return C_CLIMB;
  if (PASS_NAMES.has(name)) return C_PASS;
  for (const s of PASS_SUFFIX) if (name.endsWith(s)) return C_PASS;
  return C_FULL;
}

/**
 * Per-state collision bytes, indexed by the 0-based states array (chunk ids are 1-based, so the page
 * reads `table[id - 1]`).
 * @param {Array} states
 * @param {Uint8Array} air    classifyStates().air
 * @param {Uint8Array} film   classifyStates().film - water, ice, slime: see-through cover
 * @param {Uint8Array} height per state, collision height in sixteenths (0 = no shape at all);
 *                            from the baked geometry, so a slab is 8 and a full cube is 16
 */
export function collisionTable(states, air, film, height, foot) {
  const t = new Uint8Array(states.length);
  for (let i = 0; i < states.length; i++) {
    if (air && air[i]) { t[i] = 0; continue; }
    if (film && film[i]) { t[i] = C_LIQUID; continue; }
    const rule = bodyRule(states[i].k);
    if (rule === C_LIQUID) { t[i] = C_LIQUID; continue; }
    if (rule & C_CLIMB) { t[i] = C_CLIMB; continue; }
    if (rule === 0) { t[i] = 0; continue; }
    // A name that is not in the plant lists but whose shape is all vertical quads is still a plant:
    // walk through it. See stateFootprints.
    if (foot && foot[i] === F_THIN) { t[i] = 0; continue; }
    const h = height ? height[i] : C_FULL;
    t[i] = h > 0 ? h : C_FULL;
  }
  return t;
}

/**
 * Collision height per state, in sixteenths of a block, straight from the baked model geometry. The
 * save stores no collision boxes, so this is the honest way to know that a half slab can be stepped up
 * and a full block cannot: a slab's quads reach 8 model units out of 16, a cube's reach 16.
 *
 * Overhangs are clamped to the cell: a fence post whose connector arms reach above the block still only
 * blocks up to its own ceiling, because this model has one box per cell.
 *
 * @param {Array} states
 * @param {(state)=>number[]} geomsOf   the geometry indices a state can draw
 * @param {(geomIndex)=>number} maxYOf  the highest vertex of that geometry, in model units
 * @param {number} unitsPerBlock        16 for the model space this asset pack bakes
 */
export function stateHeights(states, geomsOf, maxYOf, unitsPerBlock = 16) {
  const h = new Uint8Array(states.length);
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s.cube || s.fc) { h[i] = C_FULL; continue; }     // face-coded cube: the whole cell
    let top = 0;
    for (const gi of geomsOf(s)) top = Math.max(top, maxYOf(gi));
    if (top <= 0) { h[i] = 0; continue; }                 // no shape at all: nothing to hit
    h[i] = Math.max(1, Math.min(C_FULL, Math.ceil((top / unitsPerBlock) * C_FULL)));
  }
  return h;
}

// What the shape of a state is, read off its own quads rather than off its name.
export const F_NONE = 0;    // the bake gave it no quads: unknown shape, stay conservative and block
export const F_THIN = 1;    // quads, but every one of them vertical - a tuft, a fern, a ground cover
export const F_FLAT = 2;    // at least one horizontal quad: there is a top to stand on and a side to hit

/**
 * `F_THIN` is the geometric definition of a plant: a shape with no horizontal face has no top surface
 * to stand on and no thickness to lean a body against. The name lists in `bodyRule` can only know the
 * plants whose names someone typed in, and this world carries grasses, ferns, sprouts and shrubs from
 * mods whose names (`medium_grass`, `mycotoxic_grass`, `glistering_fern`) were not in any list. The
 * audit for this rule is build/dbg-plants.mjs; the test is that a cross of two vertical quads passes
 * while a fence post - which has a top face - still stops you.
 *
 * @param {(state)=>number[]} geomsOf
 * @param {(geomIndex)=>boolean} horizOf  does that quad lie flat (all four corners at one height)
 */
export function stateFootprints(states, geomsOf, horizOf) {
  const f = new Uint8Array(states.length);
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s.cube || s.fc) { f[i] = F_FLAT; continue; }
    let any = false, flat = false;
    for (const gi of geomsOf(s)) {
      any = true;
      if (horizOf(gi)) { flat = true; break; }
    }
    f[i] = any ? (flat ? F_FLAT : F_THIN) : F_NONE;
  }
  return f;
}


// ---------------------------------------------------------------------- the body itself
export function newPlayer(x, y, z) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: 0, frozen: 0, climbing: 0, inWater: 0, fell: 0 };
}

export const eyeY = (p) => p.y + BODY.eye;

const EPS = 1e-4;
// Obstacle faces all sit on the sixteenth-of-a-block grid, so a snapped position is snapped to it too:
// without that, a body resting on the floor accumulates float drift and a probe reading "feet 7" sees
// 7.000000000000003, which looks like a physics bug and is not one.
const grid = (v) => Math.round(v * 16) / 16;

/**
 * Does the body at (x, feetY, z) intersect an obstacle?
 * @param {object} flags  optional out-param: collects climb/liquid flags plus `topMax` (the highest
 *                        obstacle top penetrated - where the feet belong after a fall) and `baseMin`
 *                        (the lowest obstacle base penetrated - where the head belongs after a jump)
 * @returns {number} blocking code (the tallest obstacle hit), C_UNKNOWN if a needed cell has no data
 *                   and nothing blocked, 0 if the position is free
 */
export function hits(cell, x, y, z, flags) {
  const hw = BODY.w / 2;
  const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
  const y0 = Math.floor(y + EPS), y1 = Math.floor(y + BODY.h - EPS);
  const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
  let unknown = 0, tallest = 0;
  if (flags) { flags.topMax = -Infinity; flags.baseMin = Infinity; }
  for (let yy = y0; yy <= y1; yy++) {
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        const c = cell(xx, yy, zz);
        if (c === C_UNKNOWN) { unknown = 1; continue; }
        if (flags) {
          if (climbs(c)) flags.climb = 1;
          if (liquid(c)) flags.liquid = 1;
        }
        if (!blocks(c)) continue;
        // The obstacle only fills the bottom part of its cell; the body only intersects it if the
        // body's vertical span reaches above the cell floor and below the obstacle top.
        const top = yy + h16Of(c) / 16;
        if (top > y && yy < y + BODY.h) {
          tallest = Math.max(tallest, c & 31);
          if (flags) {
            flags.cell = [xx, yy, zz];
            if (top > flags.topMax) flags.topMax = top;
            if (yy < flags.baseMin) flags.baseMin = yy;
          }
        }
      }
    }
  }
  if (tallest) return tallest;
  return unknown ? C_UNKNOWN : 0;
}

/**
 * What is directly under the feet, and how high the top of it sits.
 * @returns {number} the obstacle top as an absolute Y, or 0 for clear air, or C_UNKNOWN
 */
export function floorTop(cell, x, y, z) {
  const hw = BODY.w / 2;
  const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
  const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
  let unknown = 0, best = 0;
  for (const yy of [Math.floor(y - EPS), Math.floor(y)]) {
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        const c = cell(xx, yy, zz);
        if (c === C_UNKNOWN) { unknown = 1; continue; }
        if (!blocks(c)) continue;
        const top = yy + h16Of(c) / 16;
        if (top <= y + EPS && top > best) best = top;
      }
    }
  }
  if (best) return best;
  return unknown ? C_UNKNOWN : 0;
}

/**
 * Move one axis, stopping at the first obstacle and closing the remaining gap up to the obstacle's
 * face, so you stand against a wall rather than 0.2 blocks short of it. Sub-stepped at 0.2 blocks so
 * a 40 blocks/s fall cannot skip a 1-block floor.
 * @returns {number} 0 moved fully, 1 stopped by geometry, C_UNKNOWN data missing
 */
function moveAxis(cell, p, axis, d) {
  if (!d) return 0;
  const sign = d > 0 ? 1 : -1;
  let left = Math.abs(d);
  while (left > 1e-9) {
    const step = Math.min(0.2, left);
    const nx = axis === 'x' ? p.x + sign * step : p.x;
    const ny = axis === 'y' ? p.y + sign * step : p.y;
    const nz = axis === 'z' ? p.z + sign * step : p.z;
    const info = {};
    const h = hits(cell, nx, ny, nz, info);
    if (h === C_UNKNOWN) return C_UNKNOWN;
    if (h) {
      // Close the remaining gap up to the obstacle's face, so you stand against a wall instead of up
      // to 0.2 blocks short of it, and land exactly on a floor instead of hovering over it.
      const hw = BODY.w / 2;
      if (axis === 'y') {
        const raw = sign < 0 ? info.topMax : info.baseMin - BODY.h - EPS;
        const ty = Number.isFinite(raw) ? grid(raw) : NaN;
        if (Number.isFinite(ty) && (sign < 0 ? ty < p.y : ty > p.y) && hits(cell, p.x, ty, p.z) === 0) p.y = ty;
      } else {
        const far = axis === 'x' ? nx + hw : nz + hw;
        const near = axis === 'x' ? nx - hw : nz - hw;
        const raw = sign > 0 ? Math.floor(far - EPS) - hw - EPS : Math.floor(near + EPS) + 1 + hw + EPS;
        const t = raw;   // not grid(): a body against a wall has no exact value to keep
        const px = axis === 'x' ? t : p.x, pz = axis === 'z' ? t : p.z;
        if (hits(cell, px, p.y, pz) === 0) { p.x = px; p.z = pz; }
      }
      return 1;
    }
    p.x = nx; p.y = ny; p.z = nz;
    left -= step;
  }
  return 0;
}

/**
 * A horizontal move that climbs a low obstacle (slab, carpet, bed, stair nosing) instead of stopping.
 * A full block is not climbed: that is what jumping is for.
 */
function moveHoriz(cell, p, axis, d) {
  if (!d) return 0;
  const r = moveAxis(cell, p, axis, d);
  if (r !== 1) return r;
  const y0 = p.y;
  const back = axis === 'x' ? p.x : p.z;
  p.y = y0 + STEP_UP;
  if (hits(cell, p.x, p.y, p.z) !== 0) { p.y = y0; return 1; }
  const r2 = moveAxis(cell, p, axis, d);
  // Judge the climb by the move it was asked for, not by an absolute distance: one frame's step is a
  // twentieth of a block, and a fixed 0.4 threshold would call every successful step-up a failure.
  if (Math.abs((axis === 'x' ? p.x : p.z) - back) < Math.abs(d) * 0.5) {
    p.y = y0;
    if (axis === 'x') p.x = back; else p.z = back;
    return 1;
  }
  return r2;
}

/** Drop onto the floor below, up to maxDrop blocks. Returns the feet Y chosen, or NaN. */
export function settleOntoFloor(cell, p, maxDrop = 4) {
  for (let d = 0; d <= maxDrop * 16; d++) {
    const y = p.y - d / 16;
    if (hits(cell, p.x, y, p.z) === C_UNKNOWN) return NaN;
    const top = floorTop(cell, p.x, y, p.z);
    if (top > 0) { p.y = top; p.vy = 0; p.onGround = 1; return top; }
    if (hits(cell, p.x, y, p.z) !== 0) return NaN;   // inside an obstacle: stop looking
  }
  return NaN;
}

/**
 * Put the body at (x, feetY, z), out of walls and onto a nearby floor. Used on entering walk mode and
 * for `?goto=`. Leaves the body alone (returns NaN) when the place is not known or not free.
 */
export function place(cell, p, x, feetY, z, opts = {}) {
  const maxRise = opts.maxRise ?? 3;
  const maxDrop = opts.maxDrop ?? 4;
  const y0 = feetY;
  let y = y0;
  const h = hits(cell, x, y, z);
  if (h === C_UNKNOWN) return NaN;
  if (h) {
    let free = NaN;
    for (let d = 1; d <= maxRise; d++) {
      if (hits(cell, x, y + d, z) === 0) { free = y + d; break; }
    }
    if (!Number.isFinite(free)) return NaN;
    y = free;
  }
  p.x = x; p.y = y; p.z = z; p.vy = 0; p.vx = 0; p.vz = 0;
  settleOntoFloor(cell, p, maxDrop);
  p.onGround = floorTop(cell, p.x, p.y, p.z) > 0 ? 1 : 0;
  return p.y;
}

/**
 * Advance the body by dt seconds of wall clock, in fixed substeps.
 *
 * @param {object} p        player state from newPlayer(); mutated
 * @param {object} input    {fx, fz} wish direction (yaw-rotated, normalised, -1..1), plus
 *                          {jump, down, sprint, sneak, fly}
 * @param {number} dt       seconds
 * @param {(x,y,z)=>number} cell   the packed cell answer, C_UNKNOWN when there is no data yet
 * @param {object} opts     {minY, maxY, speed, sprintMul, gravity, jumpV, flyV, climbV, swimV}
 * @returns {object} events {landed, frozen, substeps, hitCeiling}
 */
export function simulate(p, input, dt, cell, opts = {}) {
  const gravity = opts.gravity ?? GRAVITY;
  const jumpV = opts.jumpV ?? JUMP_V;
  const fly = !!input.fly;
  // Flight is faster than foot and it does not collide: that is what the mode is for.
  const speed = fly ? (input.sprint ? (opts.flySprint ?? FLY_V * 2) : (opts.flyV ?? FLY_V))
    : (opts.speed ?? WALK) * (input.sneak ? (opts.sneakMul ?? (SNEAK / WALK))
      : input.sprint ? (opts.sprintMul ?? (SPRINT / WALK)) : 1);
  const ev = { landed: 0, frozen: 0, substeps: 0, hitCeiling: 0 };
  let t = Math.min(dt, MAX_FRAME_DT);
  while (t > 1e-9) {
    const h = Math.min(TICK, t);
    t -= h;
    ev.substeps++;

    // ---- what is around the body
    let flags = null, top = 0;
    if (!fly) {
      flags = {};
      const here = hits(cell, p.x, p.y, p.z, flags);
      top = floorTop(cell, p.x, p.y, p.z);
      if (here === C_UNKNOWN || top === C_UNKNOWN) {
        // No voxels here yet. Hold the body still instead of integrating blind: an unloaded chunk is
        // not a hole in the world, and a fall that turns into free flight through un-streamed rock is
        // the worst possible failure for a walker. The readout says `waiting for voxels`.
        p.frozen = 1; p.vy = 0; ev.frozen = 1;
        continue;
      }
    }
    p.frozen = 0;
    p.onGround = !fly && top > 0 ? 1 : 0;
    p.climbing = !fly && flags.climb ? 1 : 0;
    p.inWater = !fly && flags.liquid ? 1 : 0;
    // Standing in a liquid with a ladder: the ladder wins, which is how you get out of a water shaft.
    if (p.climbing && input.jump) p.inWater = 0;

    // ---- velocity for this substep
    if (input.fx || input.fz) { p.vx = input.fx * speed; p.vz = input.fz * speed; }
    else { p.vx = 0; p.vz = 0; }

    if (fly) {
      const v = input.sprint ? (opts.flySprint ?? FLY_V * 2) : (opts.flyV ?? FLY_V);
      p.vy = (input.jump ? v : 0) - (input.down ? v : 0);
    } else if (p.climbing) {
      p.vy = input.jump ? (opts.climbV ?? CLIMB_V) : input.down ? -(opts.climbV ?? CLIMB_V) : 0;
    } else if (p.inWater) {
      if (input.jump) p.vy = opts.swimV ?? SWIM_V;
      else if (input.down) p.vy = -(opts.swimV ?? SWIM_V);
      else p.vy = Math.max(p.vy - gravity * 0.3 * h, -(opts.swimV ?? SWIM_V) * 1.6);
    } else if (input.jump && p.onGround) {
      p.vy = jumpV; p.onGround = 0; p.fell = 0;
    } else {
      p.vy = Math.max(p.vy - gravity * h, -(opts.fallMax ?? FALL_MAX));
    }

    // ---- move one axis at a time, so a wall stops one axis without stopping the others
    if (fly) {
      p.x += p.vx * h; p.z += p.vz * h; p.y += p.vy * h;
    } else {
      const rx = moveHoriz(cell, p, 'x', p.vx * h);
      const rz = moveHoriz(cell, p, 'z', p.vz * h);
      const dy = p.vy * h;
      const ry = moveAxis(cell, p, 'y', dy);
      if (rx === C_UNKNOWN || rz === C_UNKNOWN || ry === C_UNKNOWN) {
        // The pre-move probe looked fine but the move ran into a cell with no data - the usual case is
        // falling toward the edge of what has streamed in. Stop at the last known position rather than
        // integrating blind, and say so: a walker that free-falls through un-streamed rock and pops out
        // inside a mountain is worse than one that hovers for a fifth of a second.
        p.frozen = 1; p.vy = 0; ev.frozen = 1;
        continue;
      }
      if (ry === 1) {
        if (p.vy < 0) { if (p.fell > 1) ev.landed = p.fell; p.fell = 0; p.onGround = 1; }
        else { ev.hitCeiling = 1; }
        p.vy = 0;
      } else {
        if (p.vy < 0) { p.fell += Math.abs(dy); p.onGround = floorTop(cell, p.x, p.y, p.z) > 0 ? 1 : 0; }
        else if (p.vy > 0) p.onGround = 0;
      }
    }

    // ---- the bottom and top of the world are floors, not holes
    if (opts.minY != null && Number.isFinite(opts.minY) && p.y < opts.minY) {
      p.y = opts.minY;
      if (p.vy < 0) { if (p.fell > 1) ev.landed = p.fell; p.fell = 0; }
      p.vy = 0; p.onGround = 1;
    }
    if (opts.maxY != null && Number.isFinite(opts.maxY) && p.y > opts.maxY) { p.y = opts.maxY; p.vy = 0; }
  }
  return ev;
}

/**
 * Put the body back into the world after free flight: the first position at or below where flight left
 * it whose box is clear, and gravity does the rest. Flight can leave you inside a mountain, and a
 * collision resolver will not push a body out of solid rock - it will refuse every move, which is the
 * right answer for a walker and a dead end for a body that has just been teleported by a mode switch.
 * So leaving flight asks the world where the ground under it is, once.
 */
export function dropToClear(cell, p, maxDrop = 512) {
  for (let d = 0; d <= maxDrop; d++) {
    const y = p.y - d;
    const h = hits(cell, p.x, y, p.z);
    if (h === C_UNKNOWN) return NaN;          // no idea: wait, do not guess
    if (h === 0) { p.y = y; p.vy = 0; p.onGround = 0; return y; }
  }
  return NaN;
}
