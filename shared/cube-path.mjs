// The "plain unit cube" fast path, shared by the baker (pack-assets) and the browser mesher.
//
// Most block states in a world are full cubes whose six faces each sample one whole sprite,
// possibly rotated or mirrored (vanilla's `cube_mirrored` models and `y: 180` blockstate
// variants). Instead of storing 6 quads per variant we store six face codes per variant:
//
//     code = textureIndex * 8 + uvTransform        (uvTransform in 0..7, see faces.mjs)
//
// The mesher reconstructs the face by taking the canonical corner ring for the direction and
// looking up each corner's sprite uv through the transform, which reproduces the baked quad
// exactly (see tests/models.test.mjs, which asserts that round-trip).
import { FACE_INFO, FACE_UV_AXES, UV_TRANSFORMS, UV_TRANSFORM_BY_PERM, SPRITE_CORNERS } from './faces.mjs';

export const FACE_CODE_TR = 8;
export const MAX_ARMS = 16;

// Unit-cube corner ring per direction index, in the baker's UV_ORDER
// (c0 = u0,v0 / c1 = u1,v0 / c2 = u1,v1 / c3 = u0,v1), so a baked face can be matched
// corner-by-corner even after an apply rotation moved the corners around.
export const CANON_RING = (() => {
  const UV_ORDER = [[0, 0], [1, 0], [1, 1], [0, 1]];
  return FACE_INFO.map((info, fi) => {
    const axes = FACE_UV_AXES[fi];
    const ring = UV_ORDER.map(([s, t]) => {
      const p = [0, 0, 0];
      p[info.axis] = info.sign > 0 ? 16 : 0;
      p[axes.uAxis] = s === 0 ? (axes.uNeg ? 16 : 0) : (axes.uNeg ? 0 : 16);
      p[axes.vAxis] = t === 0 ? (axes.vNeg ? 16 : 0) : (axes.vNeg ? 0 : 16);
      return p.join(',');
    });
    // Walking the sprite's uv rectangle corner by corner says nothing about which way the quad
    // faces, and the rasteriser keeps counter-clockwise front faces: five of six rings here come out
    // clockwise, which makes every near face of every cube a back-face and shows the camera the
    // *inside* of the terrain behind it (measured by tools/winding-ray.mjs). The ring is left exactly
    // as authored because ring index k and sprite corner k are a pair - that pairing is what stands a
    // sprite upright on a face - and the winding is corrected at emit time by RING_ORDER instead.
    return ring;
  });
})();

/**
 * The order in which to visit CANON_RING corners so the quad faces outward. Same corners, same uv per
 * corner, only the traversal differs. Anything that emits a cube face must walk its corners in this
 * order (web/js/mesher.js and web/js/shell-mesh.js both do).
 */
export const RING_ORDER = FACE_INFO.map((info, fi) =>
  (ringWindsOut(CANON_RING[fi], info) ? [0, 1, 2, 3] : [3, 2, 1, 0]));

/** True when the ring's own triangle normal points along its face direction. */
function ringWindsOut(ring, info) {
  const p = ring.map((s) => s.split(',').map(Number));
  const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return n[info.axis] * info.sign > 0;
}

const CORNER_UV = new Map(SPRITE_CORNERS.map((c, i) => [c.join(','), i]));

/**
 * Encode one baked arm as six cube face codes, or null when the arm is not a plain cube.
 * `arm` quads use the baker's layout: p = 12 floats, u = 8 floats, plus d/c/s/t flags.
 * Requires: exactly one face per direction, cullface == face direction, shading on, and a
 * full-sprite (rotated/mirrored) uv rect — anything else must go through the quad path.
 */
export function cubeArmCodes(arm) {
  if (arm.length !== 6) return null;
  const code = [-1, -1, -1, -1, -1, -1];
  for (const q of arm) {
    if (q.d < 0 || q.t < 0 || q.s !== 1 || q.c !== q.d) return null;
    const ring = CANON_RING[q.d];
    const at = new Map(ring.map((p, i) => [p, i]));
    const perm = [-1, -1, -1, -1];
    for (let j = 0; j < 4; j++) {
      const i = at.get(q.p.slice(j * 3, j * 3 + 3).join(','));
      if (i === undefined) return null;                 // corner is not on the unit cube
      const uv = CORNER_UV.get(`${q.u[j * 2]},${q.u[j * 2 + 1]}`);
      if (uv === undefined) return null;                // partial sprite rect
      perm[i] = uv;
    }
    const tr = UV_TRANSFORM_BY_PERM.get(perm.join(','));
    if (tr === undefined) return null;
    if (code[q.d] !== -1) return null;                  // duplicate face
    code[q.d] = q.t * FACE_CODE_TR + tr;
  }
  return code;
}

export const decodeFaceCode = (code) => [
  Math.floor(code / FACE_CODE_TR), code % FACE_CODE_TR,
];

/**
 * One baked quad that lies exactly on one of the six faces of the unit block box, or null. The
 * baker works in 16-unit model space, so "the box" means coordinates in {0,16} on the face axis and
 * a full 0..16 span along the other two.
 */
export function boxFaceQuad(p, eps = 1e-3) {
  const near = (v, t) => Math.abs(v - t) < eps;
  let axis = -1, sign = 0;
  for (let a = 0; a < 3; a++) {
    const c0 = p[a], c1 = p[3 + a], c2 = p[6 + a], c3 = p[9 + a];
    const lo = Math.min(c0, c1, c2, c3), hi = Math.max(c0, c1, c2, c3);
    if (near(lo, hi)) {
      if (axis >= 0 || !(near(lo, 0) || near(lo, 16))) return null;
      axis = a; sign = near(lo, 0) ? -1 : 1;
    } else if (!near(lo, 0) || !near(hi, 16)) return null;
  }
  return axis < 0 ? null : { axis, sign };
}

/**
 * True when an arm paints the whole block box: six face planes covered, every quad lying on one of
 * them, nothing poking outside. Vanilla grass_block is the common case - a plain cube with a tinted
 * overlay painted onto the same side planes - so it has ten quads and fails cubeArmCodes while
 * still being a solid block. Culling, ambient occlusion and the shell pass all ask "is this a full
 * block", which is a shape question, not an encoding question, so they must not confuse the two.
 */
export function fullCubeArm(arm) {
  if (!arm.length) return false;
  const seen = new Uint8Array(6);
  for (const q of arm) {
    const box = boxFaceQuad(q.p);
    if (box === null) return false;
    const d = FACE_INFO.findIndex((f) => f.axis === box.axis && f.sign === box.sign);
    if (q.d >= 0 && q.d !== d) return false;
    seen[d] = 1;
  }
  return seen.every((v) => v === 1);
}

/**
 * Sprite uv (0..1, model space, v up) of corner `i` of direction `d` for a face code.
 * The mesher multiplies these into the atlas cell like any other quad.
 */
export function cubeFaceUV(code, i) {
  const tr = code % FACE_CODE_TR;
  return SPRITE_CORNERS[UV_TRANSFORMS[tr][i]];
}

/**
 * Per-state flags used by face culling, pass bucketing and the shell pass. Shared so the browser
 * mesher and worldd's shell builder agree on what "a full cube" means.
 * @param {Array} states atlas.json state records
 * @param {Array} textures atlas.json texture records
 */
export function classifyStates(states, textures) {
  const air = new Uint8Array(states.length);
  const cube = new Uint8Array(states.length);
  const opaque = new Uint8Array(states.length);
  // A *film* is a cover you see through to the block under it - water, ice, slime. It is not the same
  // question as "not opaque": a leaves sprite is a cutout (kind 1) whose gaps show the sky, and calling
  // a canopy a film painted water-tinted leaves over the whole far view and doubled the far geometry.
  const film = new Uint8Array(states.length);
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (s.r === 3) { air[i] = 1; continue; }
    if (s.cube) {
      cube[i] = 1;
      let full = true;
      for (const [f, code] of s.cube[0].entries()) {
        const t = textures[decodeFaceCode(code)[0]];
        if (!t || t.kind !== 0) full = false;
        if (f === 1 && t && t.kind === 2) film[i] = 1;
      }
      opaque[i] = full ? 1 : 0;
    } else if (s.fc) {
      // A full block painted with more than one quad per face (grass_block, snow-covered grass, a
      // logged cube with bark overlays): solid for culling and occlusion, and its own sprite is what
      // the far LOD should paint a column with - not whatever block happens to sit underneath it.
      cube[i] = 1;
      opaque[i] = s.op ?? 0;
    }
  }
  return { air, cube, opaque, film };
}
