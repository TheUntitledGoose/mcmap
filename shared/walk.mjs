// shared/walk.mjs - the arithmetic of the first-person rig (M11), kept out of the DOM and out of
// three.js so it can be tested like the other view policies.
//
// The orbit rig already holds everything walking needs: a target, a yaw, a pitch and a distance. The
// eye sits at target + dir*dist, so a walker is not a new camera - it is the same camera with `dist`
// driven to about zero, which makes the target the eye. Every distance policy in shared/view.mjs
// (tier distance, sharp-ring reach, skin radius, frustum) is written in terms of that distance, and
// with dist ~ 0 they all read "distance from the eye", which is exactly the first-person question.
// What does *not* follow from dist ~ 0 is how much world to ask for: an orbit asks by zoom, a walker
// asks by view depth, so `walkWant` supplies it and the wheel buys that instead of zoom.

/** Orbit distance in walking mode: the eye is on the anchor, and 5 cm of separation keeps lookAt stable. */
export const EYE_DIST = 0.05;
/** In-game eye height above the ground, in blocks. */
export const EYE_HEIGHT = 1.62;
/** Same pitch clamp the orbit rig uses (about 87 deg), so looking past the poles cannot flip the frame. */
export const PITCH_LIMIT = 1.52;
/** How near and how far a walker's view reach may go with the wheel. */
export const REACH_MIN = 96, REACH_MAX = 1600;

/**
 * Mouse-look. Same sign convention as the orbit drag that already works: moving the mouse right turns
 * right, moving it down looks down. Pitch is clamped; yaw is free (it wraps visually, nothing depends
 * on a bounded yaw).
 */
export function look({ yaw = 0, pitch = 0, dx = 0, dy = 0, sens = 0.0025, invert = false } = {}) {
  const k = invert ? -1 : 1;
  return {
    yaw: yaw - dx * sens * k,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + dy * sens * k)),
  };
}

/** Sprint is a held Ctrl: Shift is *down* when walking, the way it is sneak in the game itself. */
export const sprinting = (keys) => keys.has('ControlLeft') || keys.has('ControlRight');

/**
 * The wish direction for one frame, in the yaw plane, normalised: a diagonal is not faster than a
 * straight line. The physics body (shared/player.mjs) takes this as `fx`/`fz`; the old free-flight
 * `step()` below is the same numbers times a speed and a dt.
 */
export function wish({ keys = [], yaw = 0 } = {}) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  let fx = 0, fz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) { fx += s; fz += c; }
  if (keys.has('KeyS') || keys.has('ArrowDown')) { fx -= s; fz -= c; }
  // rightOf() is (-cos yaw, sin yaw), the same basis __world.axes measures the screen with
  if (keys.has('KeyD') || keys.has('ArrowRight')) { fx -= c; fz += s; }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) { fx += c; fz -= s; }
  const h = Math.hypot(fx, fz);
  return h > 0 ? { fx: fx / h, fz: fz / h, moving: 1 } : { fx: 0, fz: 0, moving: 0 };
}

/** Is Shift held? On the ground that is sneak, in the air it is descend. */
export const descending = (keys) => keys.has('ShiftLeft') || keys.has('ShiftRight');
/** Space: jump on foot, up in flight, up a ladder, up through water. */
export const rising = (keys) => keys.has('Space');

/**
 * One frame of walking. Returns the offset to add to the anchor, in blocks.
 *
 * Horizontal movement is in the yaw plane only - pitch does not tilt the walk, or looking up would
 * make you crawl backwards. A diagonal is the same speed as a straight line (players read a faster
 * diagonal as a bug), and vertical is Space/Shift so a walker can drop into a mine without collision.
 */
export function step({ keys = [], yaw = 0, dt = 0, speed = 14, sprint = 2.6, vertical = true } = {}) {
  const v = speed * (sprinting(keys) ? sprint : 1) * dt;
  const { fx, fz } = wish({ keys, yaw });
  const h = Math.hypot(fx, fz);
  let dy = 0;
  if (vertical) {
    if (keys.has('Space')) dy += 1;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) dy -= 1;
  }
  return {
    dx: h > 0 ? (fx / h) * v : 0,
    dz: h > 0 ? (fz / h) * v : 0,
    dy: dy * v,
  };
}

/** The wheel in walking mode buys view depth, not zoom. */
export function wheelReach(reach, deltaY = 0, { min = REACH_MIN, max = REACH_MAX, k = 0.0012 } = {}) {
  return Math.max(min, Math.min(max, (Number.isFinite(reach) ? reach : min) * Math.exp(deltaY * k)));
}

/**
 * How much world the skin is asked for while walking. An orbit sizes that from the frame's corners at
 * the orbit target; with the eye on the target the frame is a point, so the reach is the answer -
 * shortened only when fog is on, because fog past the skin edge is the thing it is there to hide.
 *
 * `descend` is how far below the eye the body is going or likely to go: a walker who is falling, or
 * flying down, or climbing a ladder, is about to need the world under them, and asking for it a second
 * later is what makes a dive outrun the bytes. The ring is square, so reaching down also reaches up -
 * the cost is real and bounded by the skin cap.
 */
export function walkWant(reach, fog = 0, descend = 0) {
  const r = Number.isFinite(reach) ? Math.max(0, reach) : 0;
  const need = r + (Number.isFinite(descend) ? Math.max(0, descend) : 0);
  return fog > 0 ? Math.min(need, Math.max(320, need * 1.35) * fog) : need;
}

/**
 * The block you would stand on, scanning down from `y0` (inclusive). `solid(y)` answers for one block
 * of the column under the eye. NaN when nothing solid is in the window: a hole in the world, not a
 * floor. The scan - not a heightmap - is the only honest answer here, because the heightmap this viewer
 * carries is WORLD_SURFACE: the top of the canopy. Standing a walker on the heightmap stands them in
 * the tree tops.
 */
export function floorUnder(solid, y0 = 0, depth = 10) {
  for (let y = Math.floor(y0); y > y0 - depth; y--) if (solid(y)) return y;
  return NaN;
}

/**
 * Climb out of solid rock. A `goto` that names a spot inside a hill would otherwise start the eye
 * inside the hill - and the floor scan would find the floor under it and stand the walker on rock they
 * cannot see. Leave the eye alone when it is already in air, and when there is no air within `maxRise`
 * (deep underground) leave it alone too: a viewer that pops you out of the cavern you are in is worse
 * than one that starts you inside a wall.
 */
export function riseToAir(solid, eye = 0, maxRise = 8) {
  const y = Math.floor(eye);
  if (!solid(y)) return eye;
  for (let n = 1; n <= maxRise; n++) if (!solid(y + n)) return y + n + 0.5;
  return eye;
}

/**
 * Stand the eye on the floor. `floorY` is the world Y of the **block** you stand on - its top face is
 * at floorY + 1, and a player's eye is `EYE_HEIGHT` above the face they stand on. Only a nudge: if the
 * floor is more than `maxStep` blocks away the walker is flying, swimming or deep in a mine on
 * purpose, and a rule that teleports you out of the tunnel you just walked into is worse than no rule.
 * `floorY` NaN means nothing is held under the eye - a hole in the data must not move the camera.
 */
export function snapTo(floorY, eye, { maxStep = 2.4, on = true } = {}) {
  if (!on || !Number.isFinite(floorY) || !Number.isFinite(eye)) return eye;
  const want = Math.floor(floorY) + 1 + EYE_HEIGHT;
  const d = want - eye;
  return Math.abs(d) > maxStep ? eye : eye + d;
}
