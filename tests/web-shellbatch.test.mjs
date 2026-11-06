// A far patch cut moved into a worker is only correct if the worker sees exactly the frames the page
// would have read. Everything about the packing is therefore pinned against the direct cut: same
// mesher, same options, byte-identical streams - and the mesher's reach outside the patch rect is
// asserted, not assumed, because a frame that reads null where the page found one opens a hole at a
// patch border.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shellFrameCols } from '../server/shell.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { WorldService } from '../server/world-service.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { PATCH_REACH, packPatchFrames, patchFrameGetter, packPatchPolicy, patchPolicy } from '../web/js/shell-batch.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// Real ids from a real frame, so the mesher resolves real sprites rather than guessing at the table.
const real = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3)));
const GRASS = real.state.find((v) => v > 0);
assert.ok(GRASS, 'the sample frame must carry a paint state');

// A synthetic neighbourhood: rolling heights, thick skin in bands, one chunk that does not exist, and
// cells the voxel detail owns. Deliberately lumpy, because the interesting part of a patch border is a
// step between two different tiers.
const store = new Map();
for (let cz = -3; cz < 20; cz++) {
  for (let cx = -3; cx < 20; cx++) {
    if (cx === 5 && cz === 5) continue;                       // a hole in the save
    const h = new Uint16Array(256), cover = new Uint16Array(256), g = new Uint16Array(256);
    const s = new Uint16Array(256), light = new Uint8Array(256), band = new Uint8Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = (z << 4) | x;
        const top = 64 + ((cx * 16 + x) % 7) + ((cz * 16 + z) % 5) + (cx > 8 ? 11 : 0);
        const bd = ((cx + cz) & 3) * 3;                       // 0, 3, 6, 9 blocks of skin
        h[i] = top + HEIGHT_BIAS;
        g[i] = top - bd + HEIGHT_BIAS;
        s[i] = GRASS;
        band[i] = bd;
        light[i] = 15 << 4;
      }
    }
    store.set(`${cx},${cz}`, openShellFrame(ab(shellFrameCols(cx, cz, h, cover, g, s, light, band))));
  }
}
const shellAt = (cx, cz) => store.get(`${cx},${cz}`) ?? null;
// Cells that differ across the patch: the border between a fine patch and a coarse one is where a
// packing mistake would show up as a cliff that only exists in one of the two cuts.
const cellFor = (cx, cz) => (cx > 8 ? 4 : cx > 0 ? 2 : 1);
const skip = (cx, cz) => cx >= 2 && cx <= 3 && cz >= 2 && cz <= 3;

const OPTS = {
  maxSkirt: 3, blend: 0.5, trackStates: true, groundFar: 1, waterOpacity: 0.72, aoFar: 0.949,
  caps: 1, capDrop: 4, capCell: 4, lightOn: 1, darkFloor: 0.32, darkGamma: 0.72, skip,
};

function cutHere(x0, z0, w, h, cell) {
  return meshShellPatch(assets, shellAt, x0, z0, w, h, { ...OPTS, cell, cellFor });
}

function cutPacked(x0, z0, w, h, cell) {
  const r = PATCH_REACH;
  const pack = packPatchFrames(shellAt, x0 - r, z0 - r, w + 2 * r, h + 2 * r);
  const get = patchFrameGetter(pack);
  const pol = packPatchPolicy(cellFor, skip, x0 - r, z0 - r, w + 2 * r, h + 2 * r);
  const local = patchPolicy(pack, pol.cells, pol.skips);
  const out = meshShellPatch(assets, get, x0, z0, w, h, {
    ...OPTS, cell, cellFor: local.cellFor, skip: local.skip,
  });
  return { ...out, get };
}

const sameStream = (a, b) => {
  assert.equal(b.count, a.count, 'vertex count');
  for (const k of ['position', 'uv', 'color']) {
    assert.equal(b[k].length, a[k].length, `${k} length`);
    for (let i = 0; i < a[k].length; i++) assert.equal(b[k][i], a[k][i], `${k}[${i}]`);
  }
  if (a.stateIds || b.stateIds) {
    assert.ok(a.stateIds && b.stateIds, 'both cuts must carry state ids');
    assert.deepEqual(Array.from(b.stateIds), Array.from(a.stateIds), 'state ids');
  }
};

for (const cell of [1, 2, 4, 16]) {
  test(`a packed patch cuts byte-identically to a live one at cell ${cell}`, () => {
    const here = cutHere(0, 0, 16, 16, cell);
    const packed = cutPacked(0, 0, 16, 16, cell);
    assert.equal(packed.get.outside, 0,
      `the mesher asked ${packed.get.outside} times outside PATCH_REACH=${PATCH_REACH} of the patch`);
    assert.ok(here.stream.count > 1000, 'a patch this size must produce real geometry');
    sameStream(here.stream, packed.stream);
    assert.equal(packed.stats.cubes, here.stats.cubes, 'same paint stats');
    assert.equal(packed.stats.caps, here.stats.caps, 'same cap count');
  });
}

test('the packed frames are the same bytes, not a re-serialisation', () => {
  const pack = packPatchFrames(shellAt, 0, 0, 8, 8);
  const get = patchFrameGetter(pack);
  const a = shellAt(1, 1), b = get(1, 1);
  assert.ok(a && b);
  for (const k of ['height', 'cover', 'ground', 'state', 'light', 'band']) {
    assert.deepEqual(Array.from(b[k]), Array.from(a[k]), `${k} plane`);
  }
  assert.equal(b.cx, a.cx); assert.equal(b.cz, a.cz);
  // A hole stays a hole, and a chunk outside the rect is reported rather than silently absent.
  assert.equal(get(5, 5), null, 'the missing chunk must read as absent');
  assert.equal(get(-1, 0), null);
  assert.equal(get.outside, 1, 'reading outside the rect must be counted');
});

test('a real neighbourhood fits the reach the packing assumes', () => {
  // The synthetic fixture proves the mechanism; this one proves the reach against real packs, which is
  // where the terrain actually gets strange (villages, ravines, forest edges).
  let worst = 0;
  for (const [wx, wz] of [[3, 3], [186, 125], [56, 56]]) {
    const x0 = (wx >> 4) * 16, z0 = (wz >> 4) * 16;
    const realAt = new Map();
    const get = (cx, cz) => {
      const k = `${cx},${cz}`;
      if (!realAt.has(k)) {
        const f = svc.shellBytes('minecraft:overworld', cx, cz);
        realAt.set(k, f ? openShellFrame(ab(f)) : null);
      }
      return realAt.get(k);
    };
    const pack = packPatchFrames(get, x0 - PATCH_REACH, z0 - PATCH_REACH, 16 + 2 * PATCH_REACH, 16 + 2 * PATCH_REACH);
    const packed = patchFrameGetter(pack);
    meshShellPatch(assets, packed, x0, z0, 16, 16, { ...OPTS, cell: 16, cellFor: () => 16, skip: null });
    worst = Math.max(worst, packed.outside);
  }
  assert.equal(worst, 0, 'the mesher reached further than the pack carries');
});
