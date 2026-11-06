// The mesh-byte park has to park the *whole* mesh, index included.
//
// Why this file exists: `stashMeshBytes` used to read `mesh.geometry.attributes.index`. In three.js an
// index buffer is not an attribute - it is `geometry.index` - so that read returned undefined and every
// parked detail mesh lost its index. `installCached` then built a geometry from 4-corners-a-quad data
// with no index, and three drew it as a triangle strip: stretched, sheared, rainbow-striped quads
// wherever a chunk had been demoted and re-installed, i.e. after panning away and back. The 9.5a pixel
// A/B did not catch it because a settled scene never touches the park.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { parkPasses, indexedMatch } from '../web/js/mesh-bytes.js';

import { buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';

// --- the three.js shape, by hand -------------------------------------------------------------
// A BufferAttribute has {array, count}; a BufferGeometry has attributes plus its own `index`.
const geom = ({ position, uv, color, index }) => ({
  attributes: {
    position: { array: position, count: position.length / 3 },
    uv: { array: uv, count: uv.length / 2 },
    color: { array: color, count: color.length / 4 },
  },
  index: index ? { array: index, count: index.length } : null,
});
const quad = (i, indexed) => {
  const n = indexed ? 4 : 6;
  const position = new Float32Array(n * 3).fill(i);
  const uv = new Float32Array(n * 2).fill(0.5);
  const color = new Uint8Array(n * 4).fill(200);
  const index = indexed ? new Uint16Array([0, 1, 2, 2, 1, 3]) : null;
  return { pass: 0, mesh: { geometry: geom({ position, uv, color, index }) } };
};

test('an indexed pass parks its index buffer, with its values and its bytes', () => {
  const { passes, bytes, indexBuffers } = parkPasses([quad(0, true)]);
  assert.equal(passes.length, 1);
  assert.equal(indexBuffers, 1, 'the park must report that it kept an index');
  assert.ok(passes[0].index, 'geometry.index, not attributes.index');
  assert.deepEqual(Array.from(passes[0].index), [0, 1, 2, 2, 1, 3]);
  assert.equal(passes[0].index.constructor, Uint16Array, 'index width is the mesher\'s, not an assumption');
  const perV = 3 * 4 + 2 * 4 + 4;                 // f32 xyz + f32 uv + u8 rgba
  assert.equal(bytes, 4 * perV + 6 * 2, 'the byte bill has to include the index');
});

test('a soup pass parks no index, and is not counted as indexed', () => {
  const { passes, indexBuffers, bytes } = parkPasses([quad(0, false)]);
  assert.equal(passes.length, 1);
  assert.equal(passes[0].index, null);
  assert.equal(indexBuffers, 0);
  assert.equal(bytes, 6 * (3 * 4 + 2 * 4 + 4));
});

test('the park is a copy: changing the source arrays cannot change what is parked', () => {
  const list = [quad(0, true)];
  const first = parkPasses(list);
  list[0].mesh.geometry.index.array[0] = 999;
  const again = parkPasses(list);
  assert.equal(first.passes[0].index[0], 0, 'a park already taken is not aliased to the geometry');
  assert.equal(again.passes[0].index[0], 999);
});

test('indexedMatch fails for exactly the bug: parked indexed, installed unindexed', () => {
  const parked = { index: new Uint16Array([0, 1, 2]) };
  assert.equal(indexedMatch(parked, { index: { array: parked.index } }), true);
  assert.equal(indexedMatch(parked, { index: null }), false);
  assert.equal(indexedMatch({ index: null }, { index: null }), true);
});

// --- and against the real mesher's own streams ------------------------------------------------
const ATLAS = 'build/assets/atlas.json';
const GEO = 'build/assets/geometry.bin';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('a real chunk mesh from the browser mesher parks every index it emitted', (t) => {
  if (!fs.existsSync(ATLAS) || !fs.existsSync(GEO)) return t.skip('assets not baked');
  const json = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
  const assets = new Assets(json, ab(fs.readFileSync(GEO)));
  const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), null);
  const map = new Map();
  const cx = 3, cz = 3;
  for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
    const b = svc.chunkBytes('minecraft:overworld', cx + dx, cz + dz);
    if (b) map.set(`${cx + dx},${cz + dz}`, openChunk(ab(b)));
  }
  const centre = map.get(`${cx},${cz}`);
  assert.ok(centre, 'chunk 3,3 must exist in this world');
  const at = (ccx, ccz, lx, ly, lz) => {
    const c = map.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);
    const s = c && c.sectionAt(ly);
    if (!s) return -1;
    const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
    return id === 0 ? -1 : id - 1;
  };
  const asGeo = (s, pass) => ({
    pass,
    mesh: {
      // exactly what attachChunkMesh and the worker hand to three.js
      geometry: {
        attributes: {
          position: { array: s.position, count: s.count },
          uv: { array: s.uv, count: s.count },
          color: { array: s.color, count: s.count },
        },
        index: s.index ? { array: s.index, count: s.index.length } : null,
      },
    },
  });
  const pick = (streams) => {
    const out = [];
    for (let pass = 0; pass < streams.length; pass++) if (streams[pass].count) out.push(asGeo(streams[pass], pass));
    return out;
  };
  const indexed = pick(meshChunk(assets, centre, at, { ao: true, index: 1 }).streams);
  const soup = pick(meshChunk(assets, centre, at, { ao: true }).streams);
  assert.ok(indexed.length, 'this chunk has to produce at least one pass');
  assert.ok(indexed.some((r) => r.mesh.geometry.index), 'the indexed path has to emit an index here');

  const { passes, indexBuffers } = parkPasses(indexed);
  assert.equal(indexBuffers, indexed.filter((r) => r.mesh.geometry.index).length,
    'every index the mesher emitted has to survive the park');
  for (const p of passes) {
    const v = p.position.length / 3;
    if (p.index) assert.equal(p.index.length, v * 6 / 4, 'indexed: four corners, six indices');
    else assert.equal(v % 6, 0, 'soup: six corners a quad');
  }
  // and the soup layout parks no index, so the two can never be mistaken for each other
  assert.equal(parkPasses(soup).indexBuffers, 0);
});
