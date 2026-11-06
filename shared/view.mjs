// How far the camera may pull back, what frustum that needs, and how wide the heightmap skin has to
// be to keep up. Pure functions so the policy is testable without a browser: the page and the tests
// read the same rules.

export const CH = 16;                                     // blocks per chunk

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Pull-back distance at which a span of `spanBlocks` just fills the viewport.
 *
 * The useful zoom range is bounded by what the browser can actually hold, not by the world: past
 * the edge of the heightmap skin there is nothing to draw, so letting the wheel pull back to
 * 30 km would just frame a haze patch in the middle of an empty sky.
 */
export const fitDistance = (spanBlocks, fovDeg = 55) =>
  spanBlocks / (2 * Math.tan((fovDeg * Math.PI) / 360));

/** Wheel limit for a given skin coverage: far enough that the skin always fills the frame. */
export const maxZoomFor = (spanBlocks, fovDeg = 55, floor = 900) =>
  Math.max(floor, Math.round(fitDistance(spanBlocks, fovDeg) * 1.25));

/**
 * Frustum for a pull-back of `dist`.
 *
 * A 0.4 near plane against a 20 000 far plane leaves a 24 bit depth buffer with nothing to
 * discriminate, and that reads as z-fighting over the whole map. Nothing can be 0.4 blocks from the
 * camera once it is kilometres out, so the near plane starts riding along with the distance past
 * 200 blocks - continuously, so crossing the threshold cannot make geometry pop.
 */
export function frustumFor(dist, spanBlocks = 0) {
  const near = dist <= 200 ? 0.4 : Math.min(512, 0.4 + (dist - 200) * 0.02);
  const far = Math.max(1600, dist + spanBlocks + 512);
  // Depth precision follows the near/far ratio. Once the far plane reaches across a dimension the
  // ratio is six orders of magnitude and the far half of the range quantises to tenths of a block,
  // which is enough for coplanar shell walls to flicker; lift the near plane with the range instead.
  // Nothing is at 40 cm from a camera that is a hundred chunks out of the terrain anyway.
  const lift = Math.min(far / 40000, dist * 0.25, 64);
  return { near: Math.max(near, lift), far };
}

/**
 * Ground distance, measured from the orbit target, that the top edge of the frustum can see.
 * Infinity when the top edge points at or above the horizon: no skin is wide enough for that, and
 * the caller falls back to what the fog can reach.
 */
export function groundReach(pitch, dist, fovDeg) {
  const half = (fovDeg * Math.PI) / 360;
  const down = pitch - half;                    // pitch > 0 means the camera sits above the target
  if (down <= 0.01 || pitch <= 0) return Infinity;
  const fromCam = (dist * Math.sin(pitch)) / Math.tan(down);
  return Math.max(0, fromCam - dist * Math.cos(pitch));
}

/**
 * tan of the angle from the view axis out to a frame corner - how much wider the frame is than its
 * vertical fov suggests. A 16:9 window at 55 degrees vertical reaches ~1.2x as far sideways as the
 * numbers above imply, and a skin sized only for the middle column leaves the corners showing their
 * stair-step edge.
 */
export const cornerTan = (fovDeg, aspect = 16 / 9) =>
  Math.tan((fovDeg * Math.PI) / 360) * Math.hypot(1, aspect);

/**
 * The pull-back ceiling for a skin of `capChunks`.
 *
 * Two things break at once when the camera goes past this: the eye leaves the skin square (its near
 * edge then cuts across the frame), and the frame corners reach past the outer ring. The 0.9 keeps a
 * ring of slack so neither edge lands inside the fog ramp.
 */
export const zoomCeiling = (capChunks, fovDeg, aspect = 16 / 9) =>
  (0.9 * CH * capChunks) / cornerTan(fovDeg, aspect);

/**
 * Radius of heightmap skin, in chunks, that this view wants.
 *
 * `want` is how far the frame can see in blocks (whichever of "where the ground runs out" and "how
 * far the fog lets you see" is nearer); `cap` is what the browser is allowed to hold. Clamped below
 * `cap` the world simply ends inside the fog; at `cap` the HUD says so rather than letting the view
 * stop short for no visible reason.
 */
export function skinRadius(dist, want, { min = 40, cap = 96 } = {}) {
  const blocks = Math.max(dist * 1.15, Number.isFinite(want) ? want * 1.02 : cap * CH);
  return clamp(Math.ceil(blocks / CH), Math.min(min, cap), cap);
}

/**
 * Where the far fog closes. Geometry that ends at a hard edge reads as "the world stopped", so the
 * can see. Fog is the only thing that can do that honestly: whatever the eye cannot resolve has
 * to be hazed out before its edge - and the fog distances are measured from the *eye*, not
 * from the orbit target, which is `dist` away. `rim` is how far the edge of the skin actually is
 * from the eye, so `far <= rim` is what hides it, and because `rim >= dist` the orbit target itself
 * is always inside the ramp: a wide pull-back never frames a bowl of pure haze.
 *
 * The 320 block floor keeps eye level readable - a 2 m pull-back must not bury the horizon.
 */
export function fogFor(dist, skinChunks, { scale = 1, edge = 0.95 } = {}) {
  const rim = Math.hypot(dist, CH * skinChunks * edge);
  const far = Math.min(Math.max(320, dist * 1.35) * scale, rim);
  return { near: Math.min(dist * 0.62 * scale, far * 0.55), far };
}

/**
 * Closest the orbiting eye can get to something `dChunks` from the orbit target.
 *
 * The eye sits on a sphere of radius `eChunks` about the target, so a place `dChunks` from the
 * target is never nearer than `|dChunks - eChunks|`. That is the number decimation has to be
 * keyed to: it is what decides the largest pixel a cell can ever cover in this view, and unlike
 * the live distance from the eye it does not move while you drag (the target and the zoom do not
 * change during an orbit), so sweeping the camera does not re-tier half the world and make the
 * far LOD flicker. Keying it on the distance from the *target* instead was worse in a different
 * way: it put the ground an arm's length from the lens in the far tier, so the foreground read as
 * flat plates with huge straight drop-offs.
 */
export function closestApproach(dChunks, eChunks) {
  return Math.abs(dChunks - eChunks);
}

/**
 * The distance a far-grid tier is keyed to, in chunks.
 *
 * `approach` is the old rule: how close the eye can get to that ground while orbiting
 * (`closestApproach`). It is honest about what the eye could resolve, but it is a function of the
 * zoom, so pulling back pushes the ground *under the crosshair* into the coarse tier too: at a 4 km
 * pull-back every chunk in the skin, including the one in the middle of the frame, went to 16-block
 * plates, and the gesture itself unloaded and reloaded the whole skin.
 *
 * `center` keys the tier on the distance from the orbit target instead, so the sharp ground sits in
 * the middle of the view at any zoom and falls off toward the rim. That is what people look for when
 * they pull back (a building, a village), and it costs the same total vertices, because the cost
 * controller still decides how far the fine region reaches. Floor of 1 chunk: a patch sitting exactly
 * on the target is not "zero blocks away", and a zero distance would ask for an infinitely fine grid.
 */
export function tierDistance(dChunks, eChunks, anchor = 'center') {
  return anchor === 'approach' ? closestApproach(dChunks, eChunks) : Math.max(1, dChunks);
}

/**
 * Biggest far-grid cell, in blocks, that still projects to under `px` pixels at `dBlocks`.
 *
 * A cell `c` blocks wide at `d` blocks away covers `c * pxPerRad / d` pixels. The far grid
 * decimates a 16x16 column grid, so the choices are powers of two and this rounds down to the
 * largest one that fits: the screen never has to hold a coarse cell wider than the budget.
 */
export function cellForPixels(dBlocks, pxPerRad, px = 2.5, max = 16) {
  const want = (px * Math.max(1, dBlocks)) / Math.max(1, pxPerRad);
  const p = 2 ** Math.floor(Math.log2(Math.max(1, want)));
  return Math.max(1, Math.min(max, p));
}

/**
 * Cost floor on the cell size at `dBlocks`, for a skin covering a disc of radius `radiusBlocks`
 * and a page budget of `maxColumns` heightmap columns.
 *
 * The pixel budget alone is honest about what the eye could resolve and silent about what the page
 * can afford: at a 300 block pull-back it asked for one-block columns across the whole held skin
 * and produced 19 M shell vertices. A single global floor (one cell size for the whole skin) is
 * cheap but wasteful in the other direction - it spends the same texels per square kilometre on
 * the horizon as at the near plane, and the horizon is where nobody can see the difference.
 *
 * So spend per solid angle instead: cells grow with distance, which makes a fixed total budget buy
 * detail where the frame is actually dense. Rounds *up* to a power of two, because over-spending
 * is the expensive direction.
 */
export function budgetCell(dBlocks, radiusBlocks, maxColumns, min = 1, max = 16, near = 128) {
  const r = Math.max(2 * near, radiusBlocks);
  const k = Math.sqrt(2 * Math.PI * Math.log(r / near) / Math.max(1, maxColumns));
  const c = k * Math.max(near, dBlocks);
  const p = 2 ** Math.ceil(Math.log2(Math.max(min, c)));
  return Math.max(min, Math.min(max, p));
}

/**
 * How face-on the ground is, seen from an eye `distBlocks` from the orbit target at `pitchRad`, for
 * ground `dBlocks` from that target. 1 means looking straight down at it, ~0 means it runs away to the
 * horizon. A column's top face only covers `pxPerRad * cell / d * face` pixels, so the distance-only
 * pixel rule asks for far too many triangles on ground seen edge-on - and ground the eye is sitting
 * over is the *face-on* case, which stays at one block per column.
 */
export function faceFactor(distBlocks, pitchRad, dBlocks) {
  const eyeH = Math.abs(distBlocks * Math.sin(pitchRad));       // eye above the orbit target
  const eyeR = Math.abs(distBlocks * Math.cos(pitchRad));       // how far out that eye sits sideways
  const hd = Math.abs(dBlocks - eyeR);
  const sd = Math.hypot(hd, eyeH);
  return sd > 0 ? Math.max(0.08, eyeH / sd) : 1;   // eye sitting exactly on the spot: face-on
}

/**
 * How far from the eye a **one block** column still spans `px` pixels, in blocks. The other half of
 * `detailRadius`, exposed because the HUD wants to say "voxel detail to N blocks".
 */
export function detailReach(pxPerRad, px = 1) {
  return Math.max(1, pxPerRad) / Math.max(0.25, px);
}

/**
 * How wide the full-resolution (one voxel mesh per chunk) ring may be at this zoom.
 *
 * A detail chunk is 16 blocks and its columns are **one block** wide, so a column covers
 * `pxPerRad / d` pixels at `d` blocks: at 830 blocks in an 800 px tall window that is one pixel, and
 * past that the triangles cannot be seen. Measured, the old behaviour kept 289 full-res chunks and
 * 9.44 M verts identical at 60 blocks and at 26 km. Note the unit: `CH * pxPerRad / d` is the size of
 * the *chunk*, which would let full-res geometry run out to 6.6 km for a one-pixel column - the bug
 * this function had when it was first written.
 *
 * The ring is anchored on the orbit target, and the *centre* of that ring is the farthest thing in
 * it from the point of closest approach, so the centre decides whether the whole ring is worth
 * drawing: with `closestApproach(0, dist) = dist`, the ring survives while `dist <= reach`.
 *
 * Returns a radius in chunks, clamped to `min..cap`; 0 means "draw no detail at all, let the far
 * grid paint it", which is exactly what the shell does at cell 1 nearby.
 */
export function detailRadius(distBlocks, pxPerRad, px = 1, cap = 8, min = 0) {
  const reachChunks = detailReach(pxPerRad, px) / CH;
  return Math.max(min, Math.min(cap, Math.floor(reachChunks - Math.abs(distBlocks) / CH)));
}

/**
 * Which parked meshes to drop to bring a byte cache back under `cap`.
 *
 * Evicting in insertion ("oldest first") order measured badly for a mesh cache: a demote pass parks
 * chunks in whatever order the mesh map happens to be in, so the nearest ones left first, and coming
 * back to the close view spent seconds re-meshing the middle of the screen while usable bytes sat
 * parked at the edge of the view. The ring always refills from the middle outward, so the farthest
 * entries from `center` are the ones to lose.
 *
 * `entries` is [[key, bytes, cx, cz], ...]; the return value is the keys to drop, farthest first.
 */
export function pickEvictions(entries, cap, center) {
  let total = 0;
  for (const e of entries) total += e[1];
  if (total <= cap) return [];
  const [ccx, ccz] = center;
  const far = entries
    .map(([k, b, cx, cz]) => [k, b, (cx - ccx) ** 2 + (cz - ccz) ** 2])
    .sort((a, b) => b[2] - a[2]);
  const out = [];
  for (const [k, b] of far) {
    if (total <= cap) break;
    out.push(k);
    total -= b;
  }
  return out;
}

/**
 * Whether to ask the WebGL context for multisample edge smoothing (MSAA).
 *
 * MSAA is the only edge smoothing this viewer has: there is no post pass, and at whole-world
 * framing nearly every quad edge is a fraction of a pixel. The measured bill (real GPU, 1280x720,
 * 9.7): at 9.4 M verts it costs 0.5 ms of a 2.6 ms GPU frame and the frame rate does not move; at
 * 31.8 M verts it costs nothing (11.5 ms with, 12.8 ms without); at 4x the pixels - what a 2x
 * screen costs - it takes a third of the frame (157 fps with, 238 without), which is what auto
 * resolution is there to buy back. Asked once, when the context is made, so it is a URL switch.
 *
 * `aa` is an explicit URL value (may be undefined), `noAA` is `?noaa`.
 */
export function aaDefault({ aa, noAA = false } = {}) {
  if (noAA) return 0;
  if (aa !== undefined && aa !== null) return aa ? 1 : 0;
  return 1;
}
