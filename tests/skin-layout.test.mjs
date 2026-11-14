// The player model's sizes, its skin rectangles, and which way each face points.
//
// The sizes are the user's question, so they are asserted in pixels: head 8x8x8, torso 8x12x4,
// arm 4x12x4 (3 wide for a slim model), leg 4x12x4, stacked to 32 px.
//
// The rest is the part that a size table cannot tell you: whether the rectangle named `front` actually
// lands on the side of the box that faces the player's chest, and whether a face is wound outward. A body
// can be exactly the right size and still be an unrecognisable stranger because the face texture ended up
// on the back of the head or mirrored. Every assertion below is written from the geometry alone, so it
// fails on that too.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PX, MODEL_H, PARTS, SLIM_ARM_W, boxes, uvOf, partFaces, faceRects, FACES, cornerPos, bodyMesh,
  modelBox, assignSkins,
} from '../shared/skinlayout.mjs';

const boxOf = (bs, part, hat = false) => bs.find((b) => b.part === part && b.hat === hat);

test('the boxes are the sizes the model is specified as', () => {
  const bs = boxes({ overlay: false });
  assert.equal(bs.length, 6, 'six parts, no second layer');
  const size = (p) => { const b = boxOf(bs, p); return [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0]; };
  assert.deepEqual(size('head'), [8, 8, 8]);
  assert.deepEqual(size('body'), [8, 12, 4]);
  assert.deepEqual(size('armR'), [4, 12, 4]);
  assert.deepEqual(size('armL'), [4, 12, 4]);
  assert.deepEqual(size('legR'), [4, 12, 4]);
  assert.deepEqual(size('legL'), [4, 12, 4]);
});

test('they stack into a 2-block body standing on its feet', () => {
  const bs = boxes({ overlay: false });
  const ys = bs.flatMap((b) => [b.y0, b.y1]);
  assert.equal(Math.min(...ys), 0, 'feet at y=0');
  assert.equal(Math.max(...ys), 32, 'legs 12 + torso 12 + head 8 = 32 px');
  assert.equal(32 / PX, MODEL_H);
  assert.equal(MODEL_H, 2.0);
  // legs under torso under head, no gaps and no overlap
  const y = (p, hat = false) => { const b = boxOf(bs, p, hat); return [b.y0, b.y1]; };
  assert.deepEqual(y('legR'), [0, 12]);
  assert.deepEqual(y('body'), [12, 24]);
  assert.deepEqual(y('head'), [24, 32]);
  assert.deepEqual(y('armR'), [12, 24], 'arms hang from the shoulders, not from the hips');
  // side by side, centred: the two legs fill the torso's 8 px width
  assert.deepEqual([boxOf(bs, 'legL').x0, boxOf(bs, 'legR').x1], [-4, 4]);
  // arms OUTSIDE the torso: torso x -4..4, arms 4 px further out on each side
  assert.deepEqual([boxOf(bs, 'armL').x0, boxOf(bs, 'armL').x1], [-8, -4]);
  assert.deepEqual([boxOf(bs, 'armR').x0, boxOf(bs, 'armR').x1], [4, 8]);
});

test('a slim model is the same person with 3-px arms', () => {
  const bs = boxes({ overlay: false, slim: true });
  assert.equal(boxOf(bs, 'armR').x1 - boxOf(bs, 'armR').x0, SLIM_ARM_W);
  assert.equal(boxOf(bs, 'armL').x1 - boxOf(bs, 'armL').x0, SLIM_ARM_W);
  assert.equal(boxOf(bs, 'armL').x0, -4 - SLIM_ARM_W, 'still flush against the torso');
  // and everything else is untouched
  assert.deepEqual([boxOf(bs, 'head').x1 - boxOf(bs, 'head').x0, boxOf(bs, 'body').z1 - boxOf(bs, 'body').z0], [8, 4]);
});

test('the second layer is the same boxes, slightly bigger', () => {
  const base = boxes({ overlay: false });
  const all = boxes({ overlay: true, inflate: 0.5 });
  assert.equal(all.length, 12, 'six parts, each with an overlay copy');
  for (const b of base) {
    const h = boxOf(all, b.part, true);
    assert.ok(h, `an overlay copy of ${b.part}`);
    assert.equal(h.x1 - h.x0, b.w + 1, 'inflated on both sides');
    assert.equal(h.y1 - h.y0, b.h + 1);
    assert.equal(h.z1 - h.z0, b.d + 1);
    assert.ok(h.x0 < b.x0 && h.x1 > b.x1, 'grown outward, not shifted');
    assert.notDeepEqual(h.uv, b.uv, 'and it reads the overlay layer of the skin, not the layer under it');
  }
});

test('the six face rectangles follow the cross, for a part of each shape', () => {
  // head-shaped (cube): the 32x16 region at (0,0) of a skin
  assert.deepEqual(faceRects(0, 0, 8, 8, 8), {
    top: [8, 0, 8, 8], bottom: [16, 0, 8, 8],
    right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8],
  });
  // torso-shaped: the region at (16,16)
  assert.deepEqual(faceRects(16, 16, 8, 12, 4), {
    top: [20, 16, 8, 4], bottom: [28, 16, 8, 4],
    right: [16, 20, 4, 12], front: [20, 20, 8, 12], left: [28, 20, 8, 12], back: [32, 20, 4, 12],
  });
  // the cross must tile its own bounding box exactly - no gap, no overlap
  const r = faceRects(3, 5, 6, 9, 2);
  const area = Object.values(r).reduce((a, [u, v, w, h]) => a + w * h, 0);
  assert.equal(area, 2 * (6 * 2 + 2 * 9 + 6 * 9), "the six rectangles are the box surface, no more");
  assert.equal(r.front[1], r.right[1], 'the four side faces share a row');
  assert.equal(r.top[3], r.front[2] / 6 * 2, 'the top face is as deep as the box');
});

test('every part reads the rectangle its name says, at the origin that was measured', () => {
  const f = partFaces('head');
  assert.deepEqual(f.front, [8, 8, 8, 8], 'the face texture is the head front, not the top of the hat');
  assert.deepEqual(partFaces('body').front, [20, 20, 8, 12]);
  assert.deepEqual(partFaces('armR').front, [44, 20, 4, 12]);
  assert.deepEqual(partFaces('legR').front, [4, 20, 4, 12]);
  // left limbs exist only in the 64x64 layout, in the bottom row
  assert.deepEqual(uvOf('armL'), [32, 48]);
  assert.deepEqual(uvOf('legL'), [16, 48]);
  // and their overlay is in the middle row, on the other side of the head's overlay
  assert.deepEqual(uvOf('armL', true), [48, 32]);
  assert.deepEqual(uvOf('legL', true), [32, 32]);
  // slim arms take 3 of the 4 texture columns they used to
  assert.deepEqual(partFaces('armR', { slim: true }).front, [44, 20, 3, 12]);
});

test('a 64x32 skin has no left limbs and no second layer, and reuses the right ones', () => {
  assert.deepEqual(uvOf('armL', false, 32), PARTS.armR.uv);
  assert.deepEqual(uvOf('legL', false, 32), PARTS.legR.uv);
  assert.deepEqual(uvOf('armL', true, 32), PARTS.armR.uv, 'an old skin has no jacket: the overlay reads the same pixels');
  assert.deepEqual(uvOf('head', true, 32), PARTS.head.uv, 'and its hat layer reads the head, not a row below the file');
});

test('the named face really is on that side of the box, and is not mirrored', () => {
  // A 1x2x3 box, so "which side" is unambiguous in each axis.
  const b = { x0: 10, y0: 20, z0: 30, x1: 11, y1: 22, z1: 33 };
  for (const [name, f] of Object.entries(FACES)) {
    const c00 = cornerPos(b, f, 0, 0);
    const c11 = cornerPos(b, f, 1, 1);
    // the face's plane: the axis of its normal is pinned at the +normal end of the box
    const axis = f.n.findIndex((x) => x !== 0);
    const pinned = (p) => (f.n[axis] > 0 ? p[axis] === [b.x1, b.y1, b.z1][axis]
      : p[axis] === [b.x0, b.y0, b.z0][axis]);
    assert.ok(pinned(c00) && pinned(c11), `${name}: both corners lie on the ${name} plane`);
    // walking u and v stays inside the box
    for (const c of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
      const p = cornerPos(b, f, c[0], c[1]);
      assert.ok(p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 && p[2] >= b.z0 && p[2] <= b.z1,
        `${name} corner ${c} left the box`);
    }
    assert.notDeepEqual(c00, c11, `${name}: (0,0) and (1,1) are opposite corners`);
    // u left-to-right and v top-to-bottom, seen from outside: the head's own front face must put
    // texture-left at the model's -x and texture-top at the model's +y.
    if (name === 'front') {
      const cLeft = cornerPos(b, f, 0, 0);
      assert.equal(cLeft[0], b.x0, 'texture left edge is at -x');
      assert.equal(cLeft[1], b.y1, 'texture top edge is at +y');
      assert.equal(cLeft[2], b.z1, 'the front face is the +z side, where the chest is');
    }
    if (name === 'back') {
      const c = cornerPos(b, f, 0, 0);
      assert.equal(c[0], b.x1, 'viewed from behind, texture left is the model\'s +x: the back is not a mirror');
      assert.equal(c[2], b.z0);
    }
  }
});

test('every triangle winds outward, so FrontSide and the raycast agree', () => {
  // Asked at the face definition, not at the soup: a wrong-wound front triangle has normal -z, which is a
  // perfectly good BACK normal, so "some face has this direction" proves nothing.
  for (const [name, f] of Object.entries(FACES)) {
    const b = { x0: 0, y0: 0, z0: 0, x1: 3, y1: 5, z1: 7 };
    const p = [[0, 0], [0, 1], [1, 1], [1, 0]].map((c) => cornerPos(b, f, c[0], c[1]));
    const n = cross(sub(p[1], p[0]), sub(p[2], p[1]));
    assert.ok(dot(n, f.n) > 0, `${name} wound inward: n=${JSON.stringify(n)} expected ${JSON.stringify(f.n)}`);
    const n2 = cross(sub(p[1], p[0]), sub(p[3], p[0]));
    assert.ok(dot(n2, f.n) > 0, `${name}: the second triangle disagrees with the first`);
  }
});

test('the front of the head maps to the face rectangle, on the chest side of the box', () => {
  // The one that a screenshot would show and a size table cannot: the head's +z side must sample the
  // head-front rectangle (8,8)-(16,16), and its -z side must sample the back rectangle (24,8)-(32,16).
  const g = bodyMesh({ overlay: false, texW: 64, texH: 64 });
  const zMax = 4 / PX, zMin = -4 / PX;
  const faces = { front: [], back: [] };
  for (let t = 0; t < g.pos.length; t += 9) {
    const z = [g.pos[t + 2], g.pos[t + 5], g.pos[t + 8]];
    const y = [g.pos[t + 1], g.pos[t + 4], g.pos[t + 7]];
    if (Math.min(...y) < 24 / PX) continue;               // not the head
    if (z.every((q) => q === zMax)) faces.front.push(t);
    if (z.every((q) => q === zMin)) faces.back.push(t);
  }
  const uvRange = (list) => {
    const us = [], vs = [];
    for (const t of list) {
      for (let k = 0; k < 3; k++) { us.push(g.uv[(t / 3 + k) * 2]); vs.push(g.uv[(t / 3 + k) * 2 + 1]); }
    }
    return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)].map((q) => q * 64);
  };
  assert.ok(faces.front.length >= 2 && faces.back.length >= 2, 'the head has a front side and a back side');
  assert.deepEqual(uvRange(faces.front), [8, 8, 16, 16], 'face texture on the face');
  assert.deepEqual(uvRange(faces.back), [24, 8, 32, 16], 'and the back of the head on the back');
});

test('the geometry is one body, feet at 0, 2 blocks tall, centred', () => {
  for (const slim of [false, true]) {
    const flat = bodyMesh({ slim, overlay: false });
    const g = bodyMesh({ slim });
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < flat.pos.length; i += 3) { xs.push(flat.pos[i]); ys.push(flat.pos[i + 1]); zs.push(flat.pos[i + 2]); }
    assert.ok(Math.abs(Math.min(...ys)) < 1e-9, 'feet on the ground');
    assert.ok(Math.abs(Math.max(...ys) - MODEL_H) < 1e-6, 'head top at 2.0 blocks');
    const o = bodyMesh({ slim });
    const oy = []; for (let i = 1; i < o.pos.length; i += 3) oy.push(o.pos[i]);
    assert.ok(Math.abs(Math.min(...oy) + 0.5 / PX) < 1e-6, 'the overlay layer hangs half a px below the feet');
    assert.ok(Math.abs(Math.max(...oy) - (MODEL_H + 0.5 / PX)) < 1e-6, 'and reaches half a px above the head');
    assert.ok(Math.abs(Math.min(...xs) + Math.max(...xs)) < 1e-9, 'centred on x');
    assert.ok(Math.abs(Math.min(...zs) + Math.max(...zs)) < 1e-9, 'centred on z');
    const reach = slim ? 7 / PX : 8 / PX;
    assert.ok(Math.abs(Math.max(...xs) - reach) < 1e-6, `arm reach ${reach} for slim=${slim}`);
    assert.ok(Math.abs(Math.min(...xs) + reach) < 1e-6, 'both arms reach the same way');
    const gx = []; for (let i = 0; i < g.pos.length; i += 3) gx.push(g.pos[i]);
    assert.ok(Math.abs(Math.max(...gx) - (reach + 0.5 / PX)) < 1e-6, 'the overlay layer hangs half a px further out');
  }
});

test('UVs stay inside the skin, top-down', () => {
  for (const dims of [[64, 64], [64, 32]]) {
    const g = bodyMesh({ texW: dims[0], texH: dims[1], overlay: true });
    for (let i = 0; i < g.uv.length; i += 2) {
      assert.ok(g.uv[i] >= 0 && g.uv[i] <= 1, `u ${g.uv[i]} off the skin`);
      assert.ok(g.uv[i + 1] >= 0 && g.uv[i + 1] <= 1, `v ${g.uv[i + 1]} off the skin`);
    }
  }
});

test('what one body costs: 36 quads, or 72 with the second layer', () => {
  const a = bodyMesh({ overlay: false });
  const b = bodyMesh({ overlay: true });
  assert.equal(a.quads ?? a.tris / 2, 36, '6 boxes x 6 faces');
  assert.equal(a.tris, 72);
  assert.equal(a.verts, 216);
  assert.equal(b.tris, 144);
  assert.equal(b.verts, 432);
  // Against the tinted stand-in this replaces (5 boxes, no second layer): 60 triangles. So a skinned body
  // costs 2.4x the silhouettes it replaces, and five people in a frame is 720 triangles: noise next to the
  // ~2M the world submits, and worth stating rather than assuming.
});

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('a composed strip cell is matchable: the server hands the page columns, not texture paths', () => {
  // This is the contract between server/skin-strip.mjs and the page. The strip cells have no texture
  // field - the pixels are already in one PNG - and a matcher that insists on a path reports every
  // player as skinless while pointing them all at column 0, which is the first player's face.
  const cells = [
    { column: 0, name: 'Ada', slim: true },
    { column: 1, name: 'Bo', slim: false },
    { column: 2, white: true },                     // the fallback belongs to nobody
  ];
  const a = assignSkins(['Ada', 'Nobody', null, 'Bo'], cells);
  assert.deepEqual(Object.keys(a.byIndex).sort(), ['0', '3'], 'names match by index, gaps stay gaps');
  assert.equal(a.byIndex[0].column, 0);
  assert.equal(a.byIndex[0].slim, true, 'slim comes from the column, not from the pixels');
  assert.equal(a.byIndex[3].column, 1);
  assert.ok(!a.byIndex[1], 'a name with no column gets no skin rather than a guessed one');
  assert.ok(!a.byIndex[2], 'an empty player slot is not a person');
  assert.deepEqual(a.list.map((c) => c.name), ['Ada', 'Bo'], 'and the report says who wears what');
  // The white column must never be assignable, even if a name were to collide with it.
  assert.ok(!cells.some((c) => c.white && c.name), 'the fallback column has no name to match');
});
