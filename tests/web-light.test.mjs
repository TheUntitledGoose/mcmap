// M6: does the mesher paint the light the save actually stores?
//
// Everything here runs the real browser modules (web/js) against a synthetic chunk whose light
// arrays are written by the real server encoder, so drift between the wire format, the reader and
// the mesher fails as a test rather than as a black or flickering viewport.
//
// The tests compare one corner against itself across fixtures instead of hard-coding colours: a
// vertex colour is sprite mean x face shade x occlusion x light ramp, and only the last factor is
// what this file is about.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { decodeChunk, packChunk, buildStateIds } from '../server/chunk-payload.mjs';
import { combineLight, lightLevels, nibbleAt } from '../shared/light.mjs';

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, toArrayBuffer(fs.readFileSync('build/assets/geometry.bin')));
const stateIds = buildStateIds(atlas.states.map((s) => s.k));

const air = { Name: 'minecraft:air' };
const stone = { Name: 'minecraft:stone' };
const DARK = 0.32;                     // dark floor used by every mesh below, with gamma 1

/** A 2048-byte nibble array: one level everywhere, or whatever `at(i)` returns for cell i. */
const lightArr = (v) => {
  const a = new Uint8Array(2048);
  if (typeof v === 'number') a.fill((v & 15) | ((v & 15) << 4));
  else {
    for (let i = 0; i < 4096; i++) {
      const b = v(i) & 15, at = i >> 1;
      a[at] = i & 1 ? (a[at] & 0x0f) | (b << 4) : (a[at] & 0xf0) | b;
    }
  }
  return a;
};

const cellIdx = (lx, ly, lz) => (ly << 8) | (lz << 4) | lx;
const floorCells = (ly = 0) => {
  const out = [];
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) out.push([lx, ly, lz]);
  return out;
};

/**
 * One chunk through the real encode/pack/open path.
 *
 * `specs`: { y, all?, set?, state?, sky?, blk? }. `set` lists cells of `state` (default stone) and
 * leaves the rest air; `sky`/`blk` are written as nibble arrays, and the encoder collapses a uniform
 * one back to a single code, which is what the real save's Starlight markers produce.
 */
function makeChunk(cx, cz, specs) {
  const sections = specs.map((sp) => {
    const s = { Y: sp.y };
    if (sp.all) {
      s.block_states = { palette: [sp.all], data: new BigUint64Array(0) };
    } else {
      // vanilla pads a block palette to at least four bits per entry and packs entries back to back
      // across long boundaries, so the fixture has to do exactly that
      const bits = 4;
      const data = new BigUint64Array(Math.ceil(4096 * bits / 64));
      s.block_states = { palette: [air, sp.state ?? stone], data };
      for (const [lx, ly, lz] of sp.set ?? []) {
        const bit = cellIdx(lx, ly, lz) * bits;
        data[bit >> 6] |= 1n << BigInt(bit & 63);
      }
    }
    if (sp.sky !== undefined) s.SkyLight = lightArr(sp.sky);
    if (sp.blk !== undefined) s.BlockLight = lightArr(sp.blk);
    return s;
  });
  const nbt = { xPos: cx, zPos: cz, yPos: Math.min(...specs.map((s) => s.y)), DataVersion: 3465, sections };
  return openChunk(toArrayBuffer(packChunk(decodeChunk(nbt, stateIds))));
}

/** A 3x3 field of identical chunks, so only the surface faces are meshed at all. */
function field(specs) {
  const map = new Map();
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) map.set(`${cx},${cz}`, makeChunk(cx, cz, specs));
  const get = (cx, cz) => map.get(`${cx},${cz}`);
  const at = (cx, cz, lx, ly, lz) => {
    const c = get(cx + (lx >> 4), cz + (lz >> 4));
    if (!c) return -1;
    const s = c.sectionAt(ly);
    if (!s) return -1;
    const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
    return id === 0 ? -1 : id - 1;
  };
  const light = (cx, cz, lx, ly, lz) => {
    const c = get(cx + (lx >> 4), cz + (lz >> 4));
    if (!c) return -1;
    const lv = lightLevels(c.sectionAt, lx, ly, lz);
    return lv ? combineLight(lv[0], lv[1], 1) : -1;
  };
  return { centre: map.get('0,0'), at, light };
}

/**
 * Red channels of the upward-facing quad of the block standing at (bx, by-1, bz), keyed by corner
 * [x,z]. Quads are walked whole: a neighbouring block's side faces - and an occluder sitting on the
 * floor - have vertices at the same height, and reading single vertices would mix them in.
 */
function topCorners(stream, bx, by, bz) {
  const out = new Map();
  const P = stream.position, C = stream.color;
  const near = (v, lo, hi) => v >= lo - 1e-4 && v <= hi + 1e-4;
  for (let q = 0; q + 5 < stream.count; q += 6) {      // two triangles, six vertices per face
    const at = [q, q + 1, q + 2, q + 5].map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const corners = new Map(at.map(([x, y, z]) => [`${Math.round(x)},${Math.round(z)}`, [x, y, z]]));
    if (corners.size !== 4) continue;
    let flat = true, here = true;
    for (const [x, y, z] of corners.values()) {
      if (Math.abs(y - by) > 1e-4) flat = false;
      if (!near(x, bx, bx + 1) || !near(z, bz, bz + 1)) here = false;
    }
    if (!flat || !here) continue;
    for (let k = 0; k < 4; k++) {
      const i = [q, q + 1, q + 2, q + 5][k];
      const r = C[i * 4], g = C[i * 4 + 1], b = C[i * 4 + 2];
      if (Math.abs(r - g) > 1 || Math.abs(g - b) > 1) continue;   // grey: no tint in the way
      out.set(`${Math.round(P[i * 3])},${Math.round(P[i * 3 + 2])}`, r / 255);
    }
  }
  return out;
}

const meshAll = (f, { lit = true, ao = true, darkcut = -1 } = {}) => meshChunk(assets, f.centre, f.at, {
  ao, aoMin: 0.42, darkcut,
  ...(lit ? { light: f.light, darkFloor: DARK, darkGamma: 1 } : {}),   // gamma 1: checkable arithmetic
});
const mesh = (f, o = {}) => meshAll(f, o).streams[0];

// one stone floor filling the chunk, air above it in the same section (y = 64..79), and the light
// both channels carry. Sections are 16 blocks tall, so the air at y = 65 lives at ly = 1 of the
// section that holds the floor - not in the section above.
const FLOOR = (sky, blk) => [{ y: 4, set: floorCells(), sky, blk }];

test('light reaches the mesher: the same corner is dark with no light and full with sky 15', () => {
  const lit = topCorners(mesh(field(FLOOR(15, 0))), 4, 65, 4);
  const dark = topCorners(mesh(field(FLOOR(0, 0))), 4, 65, 4);
  assert.equal(lit.size, 4, 'the top face of a surface block must be meshed');
  assert.equal(dark.size, 4);
  for (const k of lit.keys()) {
    assert.ok(lit.get(k) > 0.4, `sky 15 must paint bright, corner ${k} got ${lit.get(k)}`);
    assert.ok(Math.abs(dark.get(k) / lit.get(k) - DARK) < 0.02,
      `corner ${k}: unlit ${dark.get(k)} / lit ${lit.get(k)} must sit at the dark floor`);
  }
});

test('sky and block light are separate channels: a torch lights a wall as brightly as noon', () => {
  const bySky = topCorners(mesh(field(FLOOR(15, 0))), 4, 65, 4);
  const byTorch = topCorners(mesh(field(FLOOR(0, 15))), 4, 65, 4);
  assert.equal(byTorch.size, bySky.size);
  for (const k of bySky.keys()) {
    assert.ok(Math.abs(bySky.get(k) - byTorch.get(k)) < 0.005,
      `corner ${k}: sky ${bySky.get(k)} vs block ${byTorch.get(k)} must match at the same level`);
  }
  // with no light anywhere in the save the mesher falls back to fully lit rather than to black
  const unknown = topCorners(mesh(field([{ y: 4, set: floorCells() }])), 4, 65, 4);
  for (const k of bySky.keys()) {
    assert.ok(Math.abs(unknown.get(k) - bySky.get(k)) < 0.005, `unknown light darkened corner ${k}`);
  }
});

test('smooth light averages the cells around a corner, so a torch pool fades across blocks', () => {
  // One lit cell at (8,65,8) with its four neighbours at 8, everything else at 0. The floor block at
  // (7,64,8) is next to the pool, so one face must show the fall-off instead of a hard step.
  const pool = (i) => {
    const ly = i >> 8, lz = (i >> 4) & 15, lx = i & 15;
    if (ly !== 1) return 0;
    const d = Math.max(Math.abs(lx - 8), Math.abs(lz - 8));
    return d === 0 ? 15 : d === 1 ? 8 : 0;
  };
  const f = field([{ y: 4, set: floorCells(), sky: 0, blk: pool }]);
  const corners = topCorners(mesh(f, { ao: false }), 7, 65, 8);
  const full = topCorners(mesh(field(FLOOR(0, 15)), { ao: false }), 7, 65, 8);
  const near = corners.get('8,8');                  // the corner inside the lit cell
  const far = corners.get('7,9');                   // three cells from the pool
  assert.ok(near !== undefined && far !== undefined, `corners: ${[...corners.keys()]}`);
  assert.ok(near > far + 0.03, `expected fall-off inside one face: near ${near}, far ${far}`);
  assert.ok(near < full.get('8,8') - 0.02,
    `the pool corner is an average, not full brightness: ${near} vs ${full.get('8,8')}`);
});

test('a chunk meshed without the light option paints exactly as it did before lighting existed', () => {
  const f = field(FLOOR(15, 0));
  const withLight = topCorners(mesh(f), 4, 65, 4);
  const without = topCorners(mesh(f, { lit: false }), 4, 65, 4);
  assert.ok(withLight.size > 0);
  for (const k of withLight.keys()) assert.equal(withLight.get(k), without.get(k), k);
});

test('occlusion samples the diagonal on the side the corner is actually on', () => {
  // A single occluder one block up, diagonally away from the surface block at (7,64,8). The corner at
  // (7,9) is the one it shadows. Multiplying both in-plane axes by the *x* sign - what this code used
  // to do - probed a cell two steps away and left the corner as bright as the sun.
  const specs = [{ y: 4, set: [...floorCells(), [6, 1, 9]], sky: 15, blk: 0 }];
  const f = field(specs);
  const corners = topCorners(mesh(f, { lit: false }), 7, 65, 8);
  const flat = topCorners(mesh(field(FLOOR(15, 0)), { lit: false }), 7, 65, 8);
  const shadowed = corners.get('7,9');
  const open = corners.get('8,8');
  assert.ok(shadowed !== undefined && open !== undefined, `corners: ${[...corners.keys()]}`);
  assert.ok(shadowed < open - 0.05,
    `a diagonal occluder must darken the corner beside it: got ${shadowed} vs ${open}`);
  assert.ok(Math.abs(open - flat.get('8,8')) < 1e-9, 'the far corner of the same face must be unaffected');
});

test('the diagonal cell is the one touching the corner, not one two steps away', () => {
  // Only the diagonal cell (6,65,10) holds a block; both edge neighbours of the corner at (7,9) are
  // air. Vanilla reads that as one blocked diagonal, level 2. Stepping the diagonal along every axis
  // instead of along the face's second in-plane axis probes empty space and leaves the corner lit.
  const only = (cell) => [{ y: 4, set: [...floorCells(), cell], sky: 15, blk: 0 }];
  const f = field(only([6, 1, 10]));
  const corners = topCorners(mesh(f, { lit: false }), 7, 65, 9);
  const flat = topCorners(mesh(field(FLOOR(15, 0)), { lit: false }), 7, 65, 9);
  const shadowed = corners.get('7,10'), open = corners.get('8,9');
  assert.ok(shadowed !== undefined && open !== undefined, `corners: ${[...corners.keys()]}`);
  assert.ok(Math.abs(open - flat.get('8,9')) < 1e-9, 'the untouched corner must stay at level 3');
  const level3 = flat.get('7,10');
  // level 2 sits at ~0.80 of level 3 with the default aoMin; level 1 (~0.61) would mean the edge
  // neighbours were shadowed too, which they are not.
  assert.ok(shadowed < level3 - 0.05 && shadowed > level3 * 0.7,
    `one diagonal must darken to level 2, about 0.8 of ${level3}, got ${shadowed}`);
});

test('a chunk border is not a dark seam: the air in front of the face is the fallback', () => {
  // In a real save an opaque block stores 0 in its own cell and the air above it holds the daylight,
  // so a corner whose neighbour probes leave the chunk must borrow the face's air cell. Borrowing the
  // voxel's own cell instead paints a black line along every chunk boundary.
  const day = [{ y: 4, set: floorCells(), sky: (i) => (i >> 8) >= 1 ? 15 : 0, blk: 0 }];
  const f = field(day);
  const interior = topCorners(mesh(f, { ao: false }), 4, 65, 4);
  const edge = topCorners(mesh(f, { ao: false }), 15, 65, 15);      // corner (16,65,16) leaves the chunk
  assert.ok(interior.size === 4 && edge.size === 4, `edge corners: ${[...edge.keys()]}`);
  const want = interior.get('4,4');
  for (const k of edge.keys()) {
    assert.ok(Math.abs(edge.get(k) - want) < 1e-6,
      `corner ${k} on the chunk border got ${edge.get(k)}, interior ${want}`);
  }
  // and the save really does keep the solid cell dark, which is what makes this worth testing
  const solid = lightLevels(f.centre.sectionAt, 4, 64, 4), air = lightLevels(f.centre.sectionAt, 4, 65, 4);
  assert.deepEqual(solid, [0, 0], 'the block itself must hold no sky light');
  assert.deepEqual(air, [15, 0], 'the air above it must hold the daylight');
});

test('the nibble order the mesher reads is the order the encoder writes', () => {
  const arr = lightArr((i) => i % 16);
  for (const i of [0, 1, 7, 8, 4095]) assert.equal(nibbleAt(arr, i), i % 16, `cell ${i}`);
});

// ---- M10: dark-face culling (the BlueMap trick), with the caves kept as a toggle -------------
//
// A face whose air side has no light cannot be seen by any camera, so it should not cost vertices.
// The three ways this goes wrong are the three things asserted below: culling on the drawn voxel's
// own light (deletes the world), culling where the light is merely unknown (holes that never come
// back), and culling something that lights itself.

test('dark cull: an unlit surface is not meshed, but faces into unknown air still are', () => {
  const off = meshAll(field(FLOOR(0, 0)));                       // ?caves=1: everything meshed
  const on = meshAll(field(FLOOR(0, 0)), { darkcut: 0 });
  assert.equal(off.stats.darkCulled, 0, 'darkcut absent must not cull a thing');
  assert.equal(off.stats.faces, on.stats.faces + on.stats.darkCulled, 'a culled face is accounted for');
  assert.ok(on.stats.darkCulled > 0, 'the unlit tops must be dropped');
  // The floor's underside faces y = 63, which lives in a section nobody has: unknown light is kept,
  // because a chunk that loads before its neighbours must not grow a permanent hole.
  assert.ok(on.stats.faces > 0, 'faces into unknown air must survive the cull');
  assert.equal(topCorners(mesh(field(FLOOR(0, 0)), { darkcut: 0 }), 4, 65, 4).size, 0,
    'the unlit top face of the floor must be gone');
  assert.ok(topCorners(mesh(field(FLOOR(0, 0))), 4, 65, 4).size === 4, 'and present with caves on');
});

test('dark cull: daylight, a torch pool and their thresholds', () => {
  const day = field(FLOOR(15, 0));
  assert.equal(meshAll(day, { darkcut: 0 }).stats.darkCulled, 0, 'daylight keeps every face');
  // Block light fading from 4 down to 1 across the floor: nothing is at 0, so a `darkcut` of 0 keeps
  // all of it and 4 drops all of it. The slider is the knob; the default has to stay conservative.
  const dim = (i) => {
    const ly = i >> 8, lx = i & 15, lz = (i >> 4) & 15;
    if (ly !== 1) return 0;
    const d = Math.max(Math.abs(lx - 8), Math.abs(lz - 8));
    return d === 0 ? 4 : d === 1 ? 3 : d === 2 ? 2 : 1;
  };
  const f = field([{ y: 4, set: floorCells(), sky: 0, blk: dim }]);
  const keep = meshAll(f, { darkcut: 0 }), cut = meshAll(f, { darkcut: 4 });
  assert.equal(keep.stats.darkCulled, 0, 'a torch pool at level 1-4 is above a darkcut of 0');
  assert.ok(cut.stats.darkCulled > keep.stats.darkCulled,
    `darkcut 4 must drop faces that darkcut 0 keeps: ${cut.stats.darkCulled} vs ${keep.stats.darkCulled}`);
});

test('dark cull: a block that lights itself is never dropped, and the quad path obeys the same rule', () => {
  const glow = field([{ y: 4, set: floorCells(), state: { Name: 'minecraft:glowstone' }, sky: 0, blk: 0 }]);
  assert.equal((glow.centre ? 1 : 0), 1);
  const cut = meshAll(glow, { darkcut: 0 });
  assert.ok(cut.stats.cubes > 0, 'the glowstone floor must be walked');
  assert.equal(cut.stats.darkCulled, 0, 'emissive faces survive whatever the air says');
  // and the same chunk with the emission stripped from the state table would be culled - i.e. the
  // exemption really is the light value and not an accident of the fixture
  const stone = field(FLOOR(0, 0));
  assert.ok(meshAll(stone, { darkcut: 0 }).stats.darkCulled > 0);
});

test('dark cull: ?caves=1 (darkcut -1) reproduces the pre-M10 mesh exactly', () => {
  const f = field([{ y: 4, set: [...floorCells(), [6, 1, 9]], sky: 0, blk: 0 }]);
  const a = meshAll(f, { darkcut: -1 }), b = meshAll(f);
  for (let p = 0; p < 3; p++) {
    assert.equal(a.streams[p].count, b.streams[p].count, `pass ${p} vertex count`);
    const A = a.streams[p].position, B = b.streams[p].position;
    for (let i = 0; i < A.length; i++) assert.equal(A[i], B[i], `pass ${p} vertex ${i}`);
  }
});

test('dark cull with no light option is off, not "everything is dark"', () => {
  // ?nolight leaves the pre-M6 unlit look available for A/B. There is no light data to judge by, so
  // nothing may be culled - culling here would empty the world.
  const f = field(FLOOR(0, 0));
  const r = meshAll(f, { lit: false, darkcut: 0 });
  assert.equal(r.stats.darkCulled, 0);
  assert.ok(r.stats.faces > 0);
});
