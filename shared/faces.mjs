// Canonical face/direction table shared by the packer (baking, cullface) and the mesher
// (neighbour occlusion tests). DIRS order is what a mesher indexes by.
export const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_INDEX = Object.fromEntries(DIRS.map((d, i) => [d, i]));

export const FACE_INFO = DIRS.map((d) => ({
  down: { v: [0, -1, 0], axis: 1, sign: -1 },
  up: { v: [0, 1, 0], axis: 1, sign: 1 },
  north: { v: [0, 0, -1], axis: 2, sign: -1 },
  south: { v: [0, 0, 1], axis: 2, sign: 1 },
  west: { v: [-1, 0, 0], axis: 0, sign: -1 },
  east: { v: [1, 0, 0], axis: 0, sign: 1 },
})[d]);

export const FACE_DIR = Object.fromEntries(DIRS.map((d, i) => [d, FACE_INFO[i].v]));

// How a face's texture is unwrapped: which model axes drive texture U and V, and whether the
// coordinate is mirrored (16 - c). Fitted to vanilla's authored UVs across models/block/*.json
// (down/up: x,z | north: 16-x,16-y | south: x,16-y | west: z,16-y). `east` is the one weakly
// determined case (vanilla authors many deliberately mirrored door/bed halves), so it is a
// single-line switch: set false if east/west textures ever render mirrored.
export const EAST_U_NEGATE = true;

export const FACE_UV_AXES = DIRS.map((d) => ({
  down: { uAxis: 0, uNeg: false, vAxis: 2, vNeg: false },
  up: { uAxis: 0, uNeg: false, vAxis: 2, vNeg: false },
  north: { uAxis: 0, uNeg: true, vAxis: 1, vNeg: true },
  south: { uAxis: 0, uNeg: false, vAxis: 1, vNeg: true },
  west: { uAxis: 2, uNeg: false, vAxis: 1, vNeg: true },
  east: { uAxis: 2, uNeg: EAST_U_NEGATE, vAxis: 1, vNeg: true },
})[d]);

// Blockstate `apply` rotations. Order is X first, then Y, and the senses are verified against
// vanilla blockstates/barrel.json: base(+Y) with x=90 -> north, x=90,y=90 -> east,
// x=90,y=180 -> south, x=90,y=270 -> west, x=180 -> down; and oak_stairs.json
// (base tall-half +X): y=90 -> south, y=180 -> west, y=270 -> north.
export function rot90x([x, y, z]) { return [x, z, -y]; }
export function rot90y([x, y, z]) { return [-z, y, x]; }

export function applyRot(v, xDeg = 0, yDeg = 0) {
  let out = v;
  for (let i = 0; i < n90(xDeg); i++) out = rot90x(out);
  for (let i = 0; i < n90(yDeg); i++) out = rot90y(out);
  return out;
}
const n90 = (deg) => (((Math.round(Number(deg) || 0) % 360) + 360) % 360) / 90;

// The 8 dihedral symmetries of a square, written as permutations of the canonical corner
// order c0=(u0,v0) c1=(u1,v0) c2=(u1,v1) c3=(u0,v1). A baked face whose UV rect covers the
// whole sprite is always one of these, so `pack-assets` can store vanilla's
// mirrored/rotated cube variants as one small code per face instead of quad geometry.
//   0 identity  1 rot90  2 rot180  3 rot270  4 flip-u  5 flip-v  6 transpose  7 anti-transpose
export const UV_TRANSFORMS = [
  [0, 1, 2, 3], [3, 0, 1, 2], [2, 3, 0, 1], [1, 2, 3, 0],
  [1, 0, 3, 2], [3, 2, 1, 0], [0, 3, 2, 1], [2, 1, 0, 3],
];
export const UV_TRANSFORM_BY_PERM = new Map(UV_TRANSFORMS.map((p, i) => [p.join(','), i]));
// Sprite uv of each canonical corner, so a transform code decodes back to uv in the mesher:
// corner i of the face gets SPRITE_CORNERS[UV_TRANSFORMS[tr][i]].
export const SPRITE_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function dirForVec(v) {
  let best = -1, bestDot = 0.999;
  for (let i = 0; i < 6; i++) {
    const d = FACE_INFO[i].v;
    const dot = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
    if (dot > bestDot) { bestDot = dot; best = i; }
  }
  return best; // -1 for non-axis-aligned (e.g. 45 degree cross elements)
}

// Outward normal of a baked quad from its own corner winding — used for faces the baker left
// without an axis-aligned direction (45° cross elements, rotated multipart parts).
export function quadNormal(p) {
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
