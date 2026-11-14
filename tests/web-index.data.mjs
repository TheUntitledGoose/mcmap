// 9.5a: an indexed detail mesh has to be the same picture with fewer vertices.
//
// The claim being tested is narrow but absolute: switching a chunk's streams from six vertices per
// quad to four vertices plus six indices must not move a single triangle. Attributes are part of a
// triangle's identity here, so a triangle is compared by its three corners' position, uv and colour -
// which is also what catches an index that points at the wrong corner, or a quad whose two triangles
// picked the other diagonal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';

import { buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';

const ATLAS = 'build/assets/atlas.json';
const GEO = 'build/assets/geometry.bin';
const WORLD = 'DarkRPG/world';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const json = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
const assets = new Assets(json, ab(fs.readFileSync(GEO)));
const svc = new WorldService(WORLD, buildStateIds(json.states.map((s) => s.k)), null);

/** A 3x3 halo of decoded chunks, and the neighbour state lookup the browser store provides. */
function halo(dim, cx, cz) {
  const map = new Map();
  for (const dx of [-1, 0, 1]) {
    for (const dz of [-1, 0, 1]) {
      const b = svc.chunkBytes(dim, cx + dx, cz + dz);
      if (b) map.set(`${cx + dx},${cz + dz}`, openChunk(ab(b)));
    }
  }
  return {
    centre: map.get(`${cx},${cz}`),
    at: (ccx, ccz, lx, ly, lz) => {
      const c = map.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);
      const s = c && c.sectionAt(ly);
      if (!s) return -1;
      const x = lx & 15, z = lz & 15;
      const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
      return id === 0 ? -1 : id - 1;
    },
  };
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
/** One triangle, named by what the GPU would read at its three corners. */
function triKey(s, a, b, c) {
  const p = (i) => `${r4(s.position[i * 3])},${r4(s.position[i * 3 + 1])},${r4(s.position[i * 3 + 2])}`;
  const u = (i) => `${r4(s.uv[i * 2])},${r4(s.uv[i * 2 + 1])}`;
  const k = (i) => `${p(i)}|${u(i)}|${s.color[i * 4]},${s.color[i * 4 + 1]},${s.color[i * 4 + 2]}`;
  return `${k(a)}#${k(b)}#${k(c)}`;
}
function trisOf(s) {
  const out = [];
  if (s.index) for (let i = 0; i < s.index.length; i += 3) out.push(triKey(s, s.index[i], s.index[i + 1], s.index[i + 2]));
  else for (let i = 0; i < s.count; i += 3) out.push(triKey(s, i, i + 1, i + 2));
  return out.sort();
}

for (const [cx, cz] of [[3, 3], [-20, 26]]) {
  test(`indexed mesh of ${cx},${cz} is the same triangles in a smaller buffer`, () => {
    const h = halo('minecraft:overworld', cx, cz);
    assert.ok(h.centre, `no chunk ${cx},${cz}`);
    const soup = meshChunk(assets, h.centre, h.at, { ao: true }).streams;
    const ix = meshChunk(assets, h.centre, h.at, { ao: true, index: 1 }).streams;

    let soupVerts = 0, ixVerts = 0, quads = 0;
    for (let pass = 0; pass < 3; pass++) {
      assert.deepEqual(trisOf(ix[pass]), trisOf(soup[pass]), `pass ${pass}: the triangles moved`);
      assert.equal(ix[pass].count % 4, 0, 'an indexed quad is four vertices');
      assert.equal(ix[pass].index.length, soup[pass].count, 'six indices per quad either way');
      assert.ok(ix[pass].count <= ix[pass].index.length, 'indices cannot exceed the corners they name');
      for (const v of ix[pass].index) assert.ok(v < ix[pass].count, `index ${v} names a vertex that is not there`);
      assert.equal(ix[pass].tris, ix[pass].index.length / 3);
      // 16-bit indices when the mesh fits them, 32-bit when it does not: half the bytes either way
      // is not worth an overflow that draws the wrong triangles.
      const want = ix[pass].count < 65536 ? Uint16Array : Uint32Array;
      assert.equal(ix[pass].index.constructor, want,
        `pass ${pass}: ${ix[pass].count} verts got ${ix[pass].index.constructor.name}`);
      soupVerts += soup[pass].count; ixVerts += ix[pass].count; quads += soup[pass].count / 6;
    }
    assert.ok(quads > 200, `only ${quads} quads - the sample stopped being interesting`);
    // Four vertices per quad is a third fewer, and never more: the mesher has no vertex sharing yet,
    // so the indexed form cannot beat 4/6 of the soup.
    assert.ok(ixVerts <= soupVerts * (4 / 6) + 4, `${ixVerts} indexed vs ${soupVerts} soup verts`);
    console.log(`# chunk ${cx},${cz}: ${quads} quads, ${soupVerts} soup verts -> ${ixVerts} indexed`
      + ` (-${(100 * (1 - ixVerts / soupVerts)).toFixed(1)}%)`);
  });
}

test('an indexed stream still reports a null index when it was not asked for', () => {
  const h = halo('minecraft:overworld', 3, 3);
  const s = meshChunk(assets, h.centre, h.at, {}).streams[0];
  assert.equal(s.index, null);
  assert.equal(s.tris, s.count / 3);
});
