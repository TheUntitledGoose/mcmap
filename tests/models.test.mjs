// Tests for the blockstate/model baker: winding, rotation conventions, multipart, cross
// elements, tint/cutout classification. Uses real 1.20.1 + mod jars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetIndex, defaultJars } from '../server/asset-index.mjs';
import { ModelResolver, bakeApply } from '../server/model-resolve.mjs';
import { FACE_INFO } from '../shared/faces.mjs';
import { cubeArmCodes, cubeFaceUV, decodeFaceCode, CANON_RING, RING_ORDER } from '../shared/cube-path.mjs';
import { needJars } from './needs.mjs';

const SERVER_ROOT = process.env.SERVER_ROOT ?? 'DarkRPG';
const VANILLA_JAR = process.env.VANILLA_JAR ??
  'your .minecraft/versions/1.20.1/1.20.1.jar';

const index = new AssetIndex(defaultJars(SERVER_ROOT, VANILLA_JAR));
const R = new ModelResolver(index);
const texOk = () => 0; // pretend every texture exists so geometry is what we test

// Bake like the packer does: one arm per entry (weighted variants / multipart parts).
function bakeArms(name, props) {
  const applies = R.applies(name, props);
  assert.ok(applies, `no applies for ${name} ${JSON.stringify(props ?? {})}: ${[...R.notes.keys()].join(';')}`);
  return applies.map(a => bakeApply(R, a.model, a, texOk)?.quads ?? []);
}
const bake = (name, props) => bakeArms(name, props).flat();

function assertWinding(quads, label) {
  for (const q of quads) {
    const p = q.p;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const e1 = sub([p[3], p[4], p[5]], [p[0], p[1], p[2]]);
    const e2 = sub([p[6], p[7], p[8]], [p[0], p[1], p[2]]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const want = q.d >= 0 ? FACE_INFO[q.d].v : q.n;
    const dot = n[0] * want[0] + n[1] * want[1] + n[2] * want[2];
    assert.ok(dot > 0, `${label}: face dir ${q.d} winding normal ${n.map(v => +v.toFixed(2))} vs ${want}`);
  }
}

test('full cube: stone bakes weighted variants, each 6 outward faces', () => {
  const arms = bakeArms('minecraft:stone', null);
  assert.ok(arms.length >= 1, 'stone has variants');
  for (const q of arms) {
    assert.equal(q.length, 6);
    assert.deepEqual([...new Set(q.map(x => x.d))].sort(), [0, 1, 2, 3, 4, 5]);
    assertWinding(q, 'stone');
    for (const x of q) {
      const all = x.p;
      assert.equal(Math.min(...all), 0, 'cube face must sit on the block hull');
      assert.equal(Math.max(...all), 16, 'cube face must sit on the block hull');
    }
  }
});

test('mod models may parent off vanilla models (bare parent = minecraft namespace)', { skip: needJars() }, () => {
  for (const m of ['mythicmetals:block/unobtainium_block', 'darkblades:block/dark_ore']) {
    const mod = R.model(m);
    assert.ok(mod, `${m} missing`);
    assert.ok(mod.elements?.length, `${m} inherited no elements (broken parent)`);
    assert.ok(Object.keys(mod.textures).length, `${m} inherited no textures`);
  }
  const bad = [...R.missing.keys()].filter(k => /:(block|item)\/cube/.test(k));
  assert.deepEqual(bad, [], `mod models failed to reach vanilla parents: ${bad}`);
});

test('rotation convention: dispenser front lands on the facing direction', () => {
  const want = { north: 2, south: 3, west: 4, east: 5, up: 1, down: 0 };
  for (const [facing, dir] of Object.entries(want)) {
    const applies = R.applies('minecraft:dispenser', { facing, triggered: 'false' });
    const seen = new Map();
    const quads = [];
    for (const a of applies) {
      const b = bakeApply(R, a.model, a, (id) => {
        if (!seen.has(id)) seen.set(id, seen.size);
        return seen.get(id);
      });
      if (b) quads.push(...b.quads);
    }
    const frontTex = [...seen.keys()].find(k => k.includes('front'));
    assert.ok(frontTex, `dispenser has no front texture (${[...seen.keys()]})`);
    const q = quads.find(x => x.t === seen.get(frontTex));
    assert.ok(q, `no quad with ${frontTex} for facing=${facing}`);
    assert.equal(q.d, dir, `dispenser facing=${facing} -> dir ${q.d}, want front on ${facing}`);
    assert.equal(q.c, dir, `dispenser facing=${facing} cullface`);
    assertWinding(quads, `dispenser-${facing}`);
  }
});

test('stairs: rotation maps the tall half to the facing side', () => {
  const tallSide = (props) => {
    const q = bake('minecraft:oak_stairs', { half: 'bottom', shape: 'straight', ...props });
    const upper = q.filter(x => Math.max(x.p[1], x.p[4], x.p[7], x.p[10]) === 16);
    const xs = upper.flatMap(x => [x.p[0], x.p[3], x.p[6], x.p[9]]);
    const zs = upper.flatMap(x => [x.p[2], x.p[5], x.p[8], x.p[11]]);
    return { x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] };
  };
  assert.deepEqual(tallSide({ facing: 'east' }).x, [8, 16]);
  assert.deepEqual(tallSide({ facing: 'west' }).x, [0, 8]);
  assert.deepEqual(tallSide({ facing: 'south' }).z, [8, 16]);
  assert.deepEqual(tallSide({ facing: 'north' }).z, [0, 8]);
  assertWinding(bake('minecraft:oak_stairs', { facing: 'west', half: 'bottom', shape: 'straight' }), 'stairs-west');
});

test('barrel: x-then-y rotation puts the lid facing the right way', () => {
  const lidOf = (facing) => {
    const applies = R.applies('minecraft:barrel', { facing, open: 'false' });
    const seen = new Map();
    const quads = [];
    for (const a of applies) {
      const b = bakeApply(R, a.model, a, (id) => {
        if (!seen.has(id)) seen.set(id, seen.size);
        return seen.get(id);
      });
      if (b) quads.push(...b.quads);
    }
    const lid = [...seen.keys()].find(k => /barrel_top/.test(k));
    assert.ok(lid, `no lid texture among ${[...seen.keys()]}`);
    const q = quads.find(x => x.t === seen.get(lid) && x.d >= 0);
    assert.ok(q, `no lid quad (${lid})`);
    return q.d;
  };
  const want = { up: 1, down: 0, north: 2, south: 3, west: 4, east: 5 };
  for (const [f, d] of Object.entries(want)) assert.equal(lidOf(f), d, `barrel lid facing=${f}`);
});

test('multipart: fence with all connections bakes more than a post alone', () => {
  const none = bake('minecraft:oak_fence', { north: 'false', south: 'false', east: 'false', west: 'false' });
  const all = bake('minecraft:oak_fence', { north: 'true', south: 'true', east: 'true', west: 'true' });
  assert.ok(none.length > 0 && all.length > none.length, `fence ${none.length} -> ${all.length}`);
  assertWinding(all, 'fence');
});

test('cross/rotated elements: flowers get diagonal normals and stay near the block', () => {
  const q = bake('minecraft:poppy', null);
  assert.ok(q.length >= 2, `poppy quads=${q.length}`);
  const diag = q.filter(x => x.d === -1);
  assert.ok(diag.length >= 2, `expected diagonal cross faces, got dirs ${q.map(x => x.d)}`);
  const coords = q.flatMap(x => x.p);
  assert.ok(Math.max(...coords) <= 17.5 && Math.min(...coords) >= -1.5, `cross extent ${Math.min(...coords)}..${Math.max(...coords)}`);
});

test('uv stays inside 0..1 and spans a useful part of the sprite', () => {
  for (const [name, props] of [['minecraft:stone', null], ['minecraft:oak_log', { axis: 'y' }], ['minecraft:oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' }]]) {
    for (const q of bake(name, props)) {
      for (const v of q.u) assert.ok(v >= -0.01 && v <= 1.01, `${name}: uv ${v} out of range`);
      const us = [q.u[0], q.u[2], q.u[4], q.u[6]];
      assert.ok(Math.max(...us) - Math.min(...us) > 0.25, `${name}: uv span ${Math.max(...us) - Math.min(...us)}`);
    }
  }
});

test('water falls back to a cube (its model has no elements)', () => {
  const q = bake('minecraft:water', { level: '0' });
  assert.equal(q.length, 6);
  assert.deepEqual(q.map(x => x.d).sort(), [0, 1, 2, 3, 4, 5]);
});

test('modded blockstates resolve to real geometry, not cube fallbacks', { skip: needJars() }, () => {
  const names = ['darkblades:dark_ore', 'mythicmetals:unobtainium_block'];
  for (const n of names) {
    assert.ok(R.blockstate(n), `${n} has no blockstate in this pack`);
    const applies = R.applies(n, null);
    const arms = applies.map(a => bakeApply(R, a.model, a, () => 0));
    assert.ok(arms.some(a => a?.kind === 'model'), `${n} fell back instead of resolving models`);
  }
});

test('cutout vs opaque classification from decoded alpha', async () => {
  const { decodePng } = await import('../server/png.mjs');
  const { textureStats } = await import('../server/atlas.mjs');
  const glass = textureStats(decodePng(index.readPng('minecraft:block/glass')));
  const stone = textureStats(decodePng(index.readPng('minecraft:block/stone')));
  assert.ok(glass.transparent > 0, 'glass should have transparent pixels');
  assert.equal(stone.transparent, 0, 'stone should be fully opaque');
});

test('cube fast path round-trips vanilla mirrored / y-rotated variants', () => {
  const applies = R.applies('minecraft:stone', null);
  assert.equal(applies.length, 4, 'stone has four weighted variants in 1.20.1');
  const encodings = new Set();
  for (const a of applies) {
    const b = bakeApply(R, a.model, a, () => 5);
    const codes = cubeArmCodes(b.quads);
    assert.ok(codes, `${a.model} y=${a.y ?? 0} must take the cube fast path`);
    for (let d = 0; d < 6; d++) {
      const [tex, tr] = decodeFaceCode(codes[d]);
      assert.equal(tex, 5, 'texture index survives the encoding');
      assert.ok(tr >= 0 && tr < 8, `uv transform out of range: ${tr}`);
    }
    // the mesher must rebuild exactly the baked uv, corner by corner
    for (const q of b.quads) {
      const at = new Map(CANON_RING[q.d].map((p, i) => [p, i]));
      for (let j = 0; j < 4; j++) {
        const i = at.get(q.p.slice(j * 3, j * 3 + 3).join(','));
        assert.notEqual(i, undefined, `corner missing for dir ${q.d}`);
        assert.deepEqual(cubeFaceUV(codes[q.d], i), [q.u[j * 2], q.u[j * 2 + 1]],
          `uv round-trip ${a.model} d=${q.d} corner=${j}`);
      }
    }
    encodings.add(codes.join(','));
  }
  assert.ok(encodings.size >= 2, 'mirrored and rotated variants must encode distinctly');
});

test('the cube fast path winds outward along its face direction', () => {
  // CANON_RING walks the sprite's uv rectangle corner by corner, which says nothing about which way
  // the quad faces; five of the six rings come out clockwise. The ring stays as authored (ring index k
  // and sprite corner k are a pair, and that pairing is what stands a sprite upright), so RING_ORDER
  // supplies the outward traversal instead. Both meshers emit through it, and three.js culls back
  // faces, so getting this wrong hides the near half of every block in the world.
  for (let d = 0; d < 6; d++) {
    const r = CANON_RING[d].map((s) => s.split(',').map(Number));
    assert.equal(r.length, 4, `ring ${d} must have four corners`);
    const info = FACE_INFO[d];
    for (const c of r) assert.equal(c[info.axis], info.sign > 0 ? 16 : 0,
      `ring ${d} corner ${c} is not on the face plane`);
    const order = RING_ORDER[d];
    assert.deepEqual([...order].sort((x, y) => x - y), [0, 1, 2, 3], `ring order ${d} must visit each corner once`);
    const [a, b, c] = [0, 1, 2].map((i) => r[order[i]]);
    const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(n[info.axis] * info.sign > 0, `CANON_RING[${d}] visited in order ${order} winds inward`);
  }
});

test('non-cube arms stay on the quad path', () => {
  const cross = bakeArms('minecraft:poppy', null)[0];
  assert.equal(cubeArmCodes(cross), null, 'a cross plant is not a cube');
  const stairs = bakeArms('minecraft:oak_stairs', { facing: 'east', half: 'bottom', shape: 'straight' })[0];
  assert.equal(cubeArmCodes(stairs), null, 'stairs are not a cube');
});

test('cross elements with rescale span the block face-on and stay inside it', () => {
  const arms = bakeArms('minecraft:grass', null);
  assert.equal(arms.length >= 1, true);
  const quads = arms[0];
  assert.equal(quads.length, 4, 'two crossed quads, front and back');
  const bounds = (q) => {
    const p = q.p;
    return ['x', 'y', 'z'].map((_, ax) => {
      const vs = [0, 1, 2, 3].map(i => p[i * 3 + ax]);
      return [Math.min(...vs), Math.max(...vs)];
    });
  };
  for (const q of quads) {
    const [bx, by, bz] = bounds(q);
    assert.ok(bx[0] > -0.01 && bx[1] < 16.01 && bz[0] > -0.01 && bz[1] < 16.01 && by[1] < 16.01,
      `cross quad leaves the block: ${JSON.stringify([bx, by, bz])}`);
    // rescale must restore the authored extent (0.8..15.2) rather than shrinking by cos45
    assert.ok(bx[1] - bx[0] > 14, `rescale lost the quad width: x ${bx}`);
    assert.ok(by[1] - by[0] > 15, `rescale must not stretch the quad height: y ${by}`);
  }
  // the two quads run along opposite ground diagonals
  const diagSign = (q) => {
    const p = q.p;
    const cs = [0, 1, 2, 3].map(i => [p[i * 3], p[i * 3 + 2]]);
    cs.sort((a, b) => a[0] - b[0]);
    const dx = cs[3][0] - cs[0][0], dz = cs[3][1] - cs[0][1];
    return Math.sign(dx * dz);
  };
  const s0 = diagSign(quads[0]), s1 = diagSign(quads[2]);
  assert.ok(s0 !== 0 && s1 !== 0, 'cross quads must be diagonal');
  assert.notEqual(s0, s1, 'cross quads must be on opposite diagonals');
});

test('element rotation matches the blockstate apply rotation convention', async () => {
  const { rotElement } = await import('../server/model-resolve.mjs');
  const { rot90x, rot90y } = await import('../shared/faces.mjs');
  const o = [8, 8, 8];
  for (const v of [[0, 0, 0], [16, 4, 12], [3, 16, 8]]) {
    const rel = (p) => p.map((x, i) => x - o[i]);
    const add = (p) => p.map((x, i) => x + o[i]);
    const ry = rotElement(v, { axis: 'y', angle: 90, origin: o });
    const rx = rotElement(v, { axis: 'x', angle: 90, origin: o });
    assert.deepEqual(ry.map(x => Math.round(x)), add(rot90y(rel(v))), 'y90 element vs apply');
    assert.deepEqual(rx.map(x => Math.round(x)), add(rot90x(rel(v))), 'x90 element vs apply');
  }
  // rescale only stretches the plane of rotation
  const r = rotElement([16, 16, 8], { axis: 'y', angle: 45, origin: [8, 8, 8], rescale: true });
  assert.equal(Math.round((r[1] - 8) * 1000) / 1000, 8, 'rescale must leave the rotation axis alone');
  assert.ok(Math.hypot(r[0] - 8, r[2] - 8) > 7.99, 'rescale must stretch within the rotation plane');
});
