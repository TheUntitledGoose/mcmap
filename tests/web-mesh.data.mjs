// End-to-end check of the *browser* code paths (web/js) against real world data, run under Node.
// If worldd's writer and the browser reader ever drift, or the mesher mis-maps the atlas, this
// fails before a human has to stare at a black viewport.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Assets, decodeFaceCode } from '../web/js/assets.js';
import { openChunk, openBatch } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';

import { decodeChunk, packChunk, openChunk as openServerChunk, buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';

const ATLAS = 'build/assets/atlas.json';
const GEO = 'build/assets/geometry.bin';
const WORLD = 'DarkRPG/world';

function toBuffer(ab) { return Buffer.from(ab, 0, ab.byteLength); }
function toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

function loadAssets() {
  const json = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
  const g = fs.readFileSync(GEO);
  return new Assets(json, toArrayBuffer(g));
}

/** A 3x3 chunk halo plus the neighbour state lookup the browser store provides. */
// One service for the whole file: constructing a WorldService per test was pure repetition.
const svc = new WorldService(WORLD, buildStateIds(
  JSON.parse(fs.readFileSync(ATLAS, 'utf8')).states.map((s) => s.k)), null);

function makeHalo(svc, dim, cx, cz) {
  const halo = new Map();
  for (const dx of [-1, 0, 1]) {
    for (const dz of [-1, 0, 1]) {
      const b = svc.chunkBytes(dim, cx + dx, cz + dz);
      if (b) halo.set(`${cx + dx},${cz + dz}`, openChunk(toArrayBuffer(b)));
    }
  }
  return (ccx, ccz, lx, ly, lz) => {
    const c = halo.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);   // lx,lz may cross a border
    if (!c) return -1;
    const s = c.sectionAt(ly);
    if (!s) return -1;
    const x = lx & 15, z = lz & 15;
    const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
    return id === 0 ? -1 : id - 1;
  };
}

test('browser asset loader matches the geometry blob', () => {
  const a = loadAssets();
  assert.equal(a.geoms, a.json.geometry.geoms);
  assert.equal(a.quadCount, a.json.geometry.quads);
  assert.equal(a.posScale, a.json.geometry.posScale);
  assert.equal(a.states.length, a.stateIndex.size);
  assert.ok(a.stateOpaque.includes(1), 'some states must be opaque cubes');
  // every quad ref must point inside the geometry table
  for (let i = 0; i < a.quadCount; i++) {
    assert.ok(a.ref[i * 2] < a.geoms, `quad ${i} geometry index out of range`);
  }
  // atlas.json is the state order worldd numbers from, so id-1 is the atlas index
  assert.equal(a.indexOf('minecraft:stone'), a.stateIndex.get('minecraft:stone'));
  assert.ok(a.indexOf('minecraft:stone') > 0);
  assert.equal(a.indexOf('nope:nothing'), -1);
});

test('browser payload reader agrees with the server reader', () => {
  const buf = svc.chunkBytes('minecraft:overworld', 3, 3);
  assert.ok(buf && buf.length > 1000);

  const srv = openServerChunk(buf);
  const br = openChunk(toArrayBuffer(buf));
  assert.equal(br.cx, srv.cx);
  assert.equal(br.cz, srv.cz);
  assert.equal(br.yMin, srv.yMin);
  assert.equal(br.yCount, srv.yCount);
  assert.deepEqual([...br.palette], [...srv.palette]);
  assert.equal(br.sections.length, srv.sections.length);
  assert.equal(br.height.length, 256);
  assert.deepEqual([...br.height], [...srv.height]);
  for (let i = 0; i < br.sections.length; i++) {
    const a = br.sections[i], b = srv.sections[i];
    assert.equal(a.y, b.y);
    assert.equal(a.single, b.single);
    if (a.vox) assert.deepEqual([...a.vox], [...b.vox], `section ${a.y} voxels`);
  }
  // stateAt / surfaceAt agree too, at corners and mid-height
  for (const [x, z] of [[0, 0], [15, 15], [7, 9]]) {
    assert.equal(br.surfaceAt(x, z), srv.surfaceAt(x, z));
    for (const y of [srv.yMin * 16, 0, 64, (srv.yMin + srv.yCount - 1) * 16 + 15]) {
      assert.equal(br.stateAt(x, y, z), srv.stateAt(x, y, z), `stateAt(${x},${y},${z})`);
    }
  }
});

test('batch container parses into per-chunk frames', () => {
  const buf = svc.batchBytes('minecraft:overworld', 2, 2, 4, 4);
  const chunks = openBatch(toArrayBuffer(buf));
  assert.equal(chunks.length, 16);
  const seen = new Set();
  for (const c of chunks) {
    assert.ok(c.cx >= 2 && c.cx < 6 && c.cz >= 2 && c.cz < 6, `chunk ${c.cx},${c.cz} out of requested window`);
    seen.add(`${c.cx},${c.cz}`);
  }
  assert.equal(seen.size, 16);
});

test('mesher produces sane geometry from a real chunk', () => {
  const assets = loadAssets();
  const buf = svc.chunkBytes('minecraft:overworld', 3, 3);
  const chunk = openChunk(toArrayBuffer(buf));

  // neighbour callback with a 1-chunk halo, so cross-border culling is exercised
  const at = makeHalo(svc, 'minecraft:overworld', chunk.cx, chunk.cz);

  const { streams, stats } = meshChunk(assets, chunk, at);
  const total = streams.reduce((n, s) => n + s.count, 0);
  assert.ok(stats.cubes > 100, `expected many cubes, got ${stats.cubes}`);
  assert.ok(total > stats.faces, 'every face needs vertices');
  assert.equal(total % 6, 0, 'triangles come in pairs of 3 vertices');
  assert.ok(stats.culled > 0, 'interior faces must be culled');
  assert.equal(stats.unknown, 0, 'this chunk should be fully covered by the atlas');

  const y0 = chunk.yMin << 4, y1 = ((chunk.yMin + chunk.yCount) << 4);
  // Modded models may author overhang outside the block box (the packer allows it up to the
  // int16 quantised range), so bounds are permissive: they catch coordinate-frame bugs, not art.
  for (const s of streams) {
    for (let i = 0; i < s.count; i++) {
      const x = s.position[i * 3], y = s.position[i * 3 + 1], z = s.position[i * 3 + 2];
      assert.ok(x >= chunk.cx * 16 - 8 && x <= chunk.cx * 16 + 24, `x ${x} left the chunk`);
      assert.ok(z >= chunk.cz * 16 - 8 && z <= chunk.cz * 16 + 24, `z ${z} left the chunk`);
      assert.ok(y >= y0 - 8 && y <= y1 + 8, `y ${y} outside the chunk column`);
      const u = s.uv[i * 2], v = s.uv[i * 2 + 1];
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `uv ${u},${v} outside the atlas`);
      assert.ok(s.color[i * 4 + 3] === 255, 'alpha must be opaque; blending is per-pass');
    }
  }

  // a grass-topped chunk must put geometry in both the opaque and cutout buckets
  assert.ok(streams[0].count > 0, 'opaque bucket is empty');
  console.log(`# meshed chunk 3,3: cubes=${stats.cubes} noncube=${stats.quads} faces=${stats.faces} ` +
    `culled=${stats.culled} air=${stats.air} verts=${streams.map((s) => s.count).join('/')}`);

  // air-only regions of the payload produce no geometry
  for (let i = 0; i < chunk.palette.length; i++) {
    const st = chunk.palette[i] - 1;
    if (st >= 0 && assets.stateAir[st]) assert.equal(assets.states[st].cube, undefined);
  }
});

test('mesher maps the top of a block face to the top row of its sprite', () => {
  // The vertical orientation bug this catches: atlas uv and the uploaded image disagree about which
  // end of a sprite is up, which renders every block upside down while all the numbers still look
  // plausible. So check the whole chain on real data: model-top vertex -> atlas v of the cell's
  // first pixel row.
  const assets = loadAssets();
  const chunk = openChunk(toArrayBuffer(svc.chunkBytes('minecraft:overworld', 3, 3)));
  const at = makeHalo(svc, 'minecraft:overworld', 3, 3);
  const isAirId = (id) => !id || assets.stateAir[id - 1] === 1;
  const { streams } = meshChunk(assets, chunk, at);

  // an opaque cube block, air to the south, whose south face uses the identity uv transform
  let target = null;
  for (let ly = 0; ly < chunk.yCount * 16 && !target; ly++) {
    const y = (chunk.yMin << 4) + ly;
    if (!chunk.sectionAt(y)) continue;
    for (let lz = 0; lz < 15 && !target; lz++) {
      for (let lx = 0; lx < 15 && !target; lx++) {
        const id = chunk.stateAt(lx, y, lz);
        const st = id ? assets.states[id - 1] : null;
        if (!st?.cube || !isAirId(chunk.stateAt(lx, y, lz + 1))) continue;
        const codes = st.cube.map((arm) => decodeFaceCode(arm[3]));
        const cell = assets.texCell(codes[0][0]);
        if (!codes.every(([, t]) => t === 0) || codes.some(([tx]) => tx !== codes[0][0])) continue;
        if (!cell || cell.kind !== 0 || cell.w < 8) continue;
        target = { x: chunk.cx * 16 + lx, y, z: chunk.cz * 16 + lz, cell };
      }
    }
  }
  assert.ok(target, 'chunk 3,3 must contain at least one plain opaque cube with an exposed south face');

  // collect the triangles the mesher emitted for that one face: all three vertices must lie on the
  // face plane and inside the unit square, which rules out the block's own other faces (those are
  // not planar at this z) as well as neighbouring columns
  const EPS = 1e-4, tris = [];
  for (const s of streams) {
    for (let i = 0; i + 2 < s.count; i += 3) {
      const p = [0, 1, 2].map((k) => ({
        x: s.position[(i + k) * 3], y: s.position[(i + k) * 3 + 1], z: s.position[(i + k) * 3 + 2],
        u: s.uv[(i + k) * 2], v: s.uv[(i + k) * 2 + 1],
      }));
      if (p.some((q) => Math.abs(q.z - (target.z + 1)) > EPS)) continue;
      if (p.some((q) => q.x < target.x - EPS || q.x > target.x + 1 + EPS)) continue;
      if (p.some((q) => q.y < target.y - EPS || q.y > target.y + 1 + EPS)) continue;
      tris.push(p);
    }
  }
  assert.ok(tris.length >= 2, `expected a face of at least 2 triangles, found ${tris.length}`);
  for (const t of tris) {
    for (const p of t) {
      const topEdge = Math.abs(p.y - (target.y + 1)) < EPS;
      const botEdge = Math.abs(p.y - target.y) < EPS;
      assert.ok(topEdge || botEdge, `face vertex y=${p.y} is not on the face's top or bottom edge`);
      const wantV = topEdge ? target.cell.v0 : target.cell.v1;
      assert.ok(Math.abs(p.v - wantV) < 1e-3,
        `y=${p.y} vertex v=${p.v} should sit on the ${topEdge ? 'top' : 'bottom'} row (v0=${target.cell.v0}, v1=${target.cell.v1}) - sprite is flipped`);
      const wantU = p.x > target.x + 0.5 ? target.cell.u1 : target.cell.u0;
      assert.ok(Math.abs(p.u - wantU) < 1e-3, `vertex u=${p.u} does not follow x at ${target.x},${target.y},${target.z}`);
    }
  }
  console.log(`# orientation check: block ${target.x},${target.y},${target.z} face=${tris.length} triangles, ` +
    `cell v0=${target.cell.v0.toFixed(5)} v1=${target.cell.v1.toFixed(5)}`);
});

test('ambient occlusion darkens corners that neighbours cover', () => {
  const assets = loadAssets();
  const chunk = openChunk(toArrayBuffer(svc.chunkBytes('minecraft:overworld', 3, 3)));
  const at = makeHalo(svc, 'minecraft:overworld', 3, 3);

  const off = meshChunk(assets, chunk, at, { ao: false }).streams[0];
  const on = meshChunk(assets, chunk, at, { ao: true }).streams[0];
  assert.equal(on.count, off.count, 'AO changes colour only, never geometry');

  const rgb = (s, v) => (s.color[v * 4] << 16) | (s.color[v * 4 + 1] << 8) | s.color[v * 4 + 2];
  const lum = (c) => (c >> 16) + ((c >> 8) & 255) + (c & 255);
  // Without AO a quad is one flat colour; with AO its corners are allowed to differ.
  let flat = 0, varied = 0, brighter = 0;
  for (let q = 0; q < on.count; q += 6) {
    const base = lum(rgb(off, q));
    let allSame = true, varies = false;
    for (let i = 0; i < 6; i++) {
      if (rgb(off, q + i) !== rgb(off, q)) allSame = false;
      if (rgb(on, q + i) !== rgb(on, q)) varies = true;
      const l = lum(rgb(on, q + i));
      if (l > base + 2) brighter++;
      // AO's darkest level is 0.42x the face shade, so nothing should fall far below it
      assert.ok(l >= base * 0.35, `corner darkened past the AO floor: ${l} vs ${base}`);
    }
    if (allSame) flat++;
    if (varies) varied++;
  }
  assert.ok(flat > 100, 'without AO every quad should be flat shaded');
  assert.ok(varied > 100, `with AO many quads should shade their corners, got ${varied}`);
  assert.equal(brighter, 0, 'AO must never brighten a face');

  // The shading is a pure function of the voxel grid, so two runs must agree byte for byte.
  const again = meshChunk(assets, chunk, at, { ao: true }).streams[0];
  assert.deepEqual(Array.from(again.color), Array.from(on.color), 'AO must be deterministic');
});

test('mesher is deterministic across a chunk border', () => {
  const assets = loadAssets();
  const svc = new WorldService(WORLD, buildStateIds(assets.json.states.map((s) => s.k)), null);
  const bA = svc.chunkBytes('minecraft:overworld', 3, 3);
  const bB = svc.chunkBytes('minecraft:overworld', 4, 3);
  const A = openChunk(toArrayBuffer(bA)), B = openChunk(toArrayBuffer(bB));
  const pair = { '3,3': A, '4,3': B };
  const at = (cx, cz, lx, ly, lz) => {
    const c = pair[`${cx + (lx >> 4)},${cz + (lz >> 4)}`];
    if (!c) return -1;
    const s = c.sectionAt(ly);
    if (!s) return -1;
    const x = lx & 15, z = lz & 15;
    const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
    return id === 0 ? -1 : id - 1;
  };
  const alone = meshChunk(assets, A, (cx, cz, lx, ly, lz) => (cx === 3 && cz === 3 ? at(cx, cz, lx, ly, lz) : -1));
  const withNeighbour = meshChunk(assets, A, at);
  assert.ok(withNeighbour.stats.culled >= alone.stats.culled, 'a loaded neighbour can only cull more');

  // variant selection is keyed by world position, not by array index or load order, so the same
  // block keeps its texture when neighbouring chunks stream in
  const hashOf = (m) => {
    let h = 0;
    for (const s of m.streams) {
      for (let i = 0; i < Math.min(s.count, 4000) * 2; i++) h = (Math.imul(h, 31) + Math.round(s.uv[i] * 1e6)) | 0;
    }
    return h;
  };
  const again = meshChunk(assets, A, (cx, cz, lx, ly, lz) => (cx === 3 && cz === 3 ? at(cx, cz, lx, ly, lz) : -1));
  assert.equal(hashOf(alone), hashOf(again), 'meshing the same voxels twice must give the same result');
  // faces that survive culling in both runs must pick identical atlas texels
  const texels = (m) => new Set(m.streams.flatMap((s) => Array.from(s.uv.subarray(0, s.count * 2)).map((x) => x.toFixed(4))));
  const shared = [...texels(alone)].filter((x) => texels(withNeighbour).has(x));
  assert.ok(shared.length > 100, 'expected shared texel coordinates between the two runs');
});

test('the detail mesher winds triangles so their face points away from solid ground', () => {
  // Winding is invisible to the data layer and fatal in three.js, which culls back faces: with the
  // cube rings wound clockwise every near face disappears and the camera sees the far side of the
  // terrain instead (measured by tools/winding-ray.mjs). So assert on the emitted triangles.
  const assets = loadAssets();
  const svc = new WorldService(WORLD, buildStateIds(assets.json.states.map((s) => s.k)), null);
  const chunk = openChunk(toArrayBuffer(svc.chunkBytes('minecraft:overworld', 3, 3)));
  const at = makeHalo(svc, 'minecraft:overworld', 3, 3);
  const { streams } = meshChunk(assets, chunk, at);
  // world-space lookup: the halo folds (lx >> 4) into its chunk key, so passing chunk 0 works
  const opaque = (wx, wy, wz) => {
    const id = at(0, 0, wx, wy, wz);
    return id >= 0 && assets.stateOpaque[id] === 1;
  };
  let outward = 0, inward = 0, ambiguous = 0;
  for (const st of streams) {
    for (let q = 0; q < st.count; q += 6) {
      const p = [0, 1, 2, 3].map((k) => [st.position[(q + k) * 3], st.position[(q + k) * 3 + 1], st.position[(q + k) * 3 + 2]]);
      const u = p[1].map((v, i) => v - p[0][i]), w = p[2].map((v, i) => v - p[0][i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const ax = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
      // only perfectly axis-aligned faces can be attributed to a neighbour cell; a slanted modded
      // element face (crystal clusters, diagonal log geometry) has no single neighbour to check
      if (Math.abs(n[ax]) < Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) - 1e-6) continue;
      // verts 0 and 2 are opposite corners either way, whether or not the diagonal was swapped for AO
      const c = [0, 1, 2].map((i) => (p[0][i] + p[2][i]) / 2);
      const off = [0, 0, 0];
      off[ax] = n[ax] > 0 ? 0.5 : -0.5;
      const front = opaque(Math.floor(c[0] + off[0]), Math.floor(c[1] + off[1]), Math.floor(c[2] + off[2]));
      const back = opaque(Math.floor(c[0] - off[0]), Math.floor(c[1] - off[1]), Math.floor(c[2] - off[2]));
      if (back && !front) outward++;
      else if (front && !back) inward++;
      else ambiguous++;
    }
  }
  assert.ok(outward > 1000, `only ${outward} axis-aligned faces to check`);
  assert.equal(inward, 0, `${inward} triangles face into the ground instead of out of it`);
  console.log(`winding tally: outward ${outward}, ambiguous ${ambiguous}`);
});

// Vanilla ships some sprites as grey masks to be tinted per biome and others already coloured. The
// atlas measures which is which; multiplying a green tint into an already brown sprite is what turned
// the sides of grass blocks olive, so this pins both halves of that decision.
test('a grey-mask sprite is tinted, an already coloured sprite is not', () => {
  const assets = loadAssets();
  const grassIdx = assets.indexOf('minecraft:grass_block|snowy=false');
  assert.ok(grassIdx >= 0, 'grass_block must be in the atlas table');

  // One block of grass, alone, with unknown neighbours: nothing gets culled, so the top face and the
  // four side faces of the same state are all in the stream.
  const raw = packChunk({
    cx: 0, cz: 0, yMin: 0, yCount: 1,
    palette: [grassIdx + 1],
    sections: [{ y: 0, single: 1, vox: null }],
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, classicSections: false,
  });
  const chunk = openChunk(toArrayBuffer(raw));
  const { streams } = meshChunk(assets, chunk, () => -1, { ao: false });

  const faces = { top: null, side: null };
  for (const s of streams) {
    for (let q = 0; q < s.count; q += 6) {
      const a = q * 3, b = a + 3, c = a + 6;
      if (c >= s.count) break;
      const ux = s.position[b] - s.position[a], uy = s.position[b + 1] - s.position[a + 1], uz = s.position[b + 2] - s.position[a + 2];
      const vx = s.position[c] - s.position[a], vy = s.position[c + 1] - s.position[a + 1], vz = s.position[c + 2] - s.position[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const col = [s.color[q * 4], s.color[q * 4 + 1], s.color[q * 4 + 2]];
      if (ny > 0 && Math.abs(nx) < 1e-6 && Math.abs(nz) < 1e-6) faces.top ??= col;
      else if (Math.abs(ny) < 1e-6 && (Math.abs(nx) > 1e-6 || Math.abs(nz) > 1e-6)) faces.side ??= col;
    }
  }
  assert.ok(faces.top && faces.side, 'expected both a top and a side face for one grass block');
  const [tr, tg, tb] = faces.top;
  assert.ok(tg > tr && tg > tb, `grass top must read green, got rgb(${faces.top})`);
  const [sr, sg, sb] = faces.side;
  assert.equal(sr, sg, `grass side must not be tinted, got rgb(${faces.side})`);
  assert.equal(sg, sb, `grass side must not be tinted, got rgb(${faces.side})`);
  assert.ok(sr > 0, 'an untinted face still carries its face shading');
});

// Tint matches the block name, not the whole state key: almost every state here carries
// `waterlogged=false`, and a regex over the key handed every waterlogged leaf the blue water tint.
test('tint keys off the block name, not the state properties', async () => {
  const { tintOf } = await import('../web/js/mesher.js');
  assert.deepEqual(tintOf({ k: 'minecraft:oak_leaves|distance=7,persistent=false,waterlogged=false' }),
    [0.37, 0.64, 0.28], 'waterlogged leaves are still leaves');
  assert.deepEqual(tintOf({ k: 'minecraft:kelp|waterlogged=false' }), [0.4, 0.78, 0.32]);
  assert.deepEqual(tintOf({ k: 'minecraft:water|level=3' }), [0.3, 0.55, 0.85]);
  assert.deepEqual(tintOf({ k: 'minecraft:grass_block|snowy=false' }), [0.4, 0.78, 0.32]);
  assert.deepEqual(tintOf({ k: 'minecraft:stone' }), [1, 1, 1], 'stone wants no tint at all');
});

// A section stored as one repeated state is walked only along the outside of its 16^3 box, a 3x cut
// in section cost. That is only allowed to be a speed-up: the same voxels written out longhand must
// produce byte-identical triangles, including their shading.
test('a section stored once produces the same mesh as a section stored 4096 times', () => {
  const assets = loadAssets();
  const stone = assets.indexOf('minecraft:stone') + 1;
  const grass = assets.indexOf('minecraft:grass_block|snowy=false') + 1;
  const air = assets.indexOf('minecraft:air') + 1;
  assert.ok(stone > 0 && grass > 0 && air > 0, 'the test states must be in the atlas table');
  assert.ok(assets.states[stone - 1].cube, 'stone must be on the cube fast path');
  assert.ok(assets.states[grass - 1].fc === 1, 'grass_block must fill its box without the fast path');

  // One section of solid stone plus one ragged layer above it, so the uniform fast path and the
  // general walk both run over the same chunk. Palette slots, not state ids, go in `vox`.
  const vox = new Uint16Array(4096).fill(2);                      // slot 2 = air
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      vox[(1 << 8) | (lz << 4) | lx] = 1;                         // slot 1 = grass_block floor
      vox[(2 << 8) | (lz << 4) | lx] = (lx + lz) % 2 ? 0 : 2;     // slot 0 = stone, ragged
    }
  }
  const chunk = openChunk(toArrayBuffer(packChunk({
    cx: 4, cz: 4, yMin: 2, yCount: 3,   // yMin is a SECTION index on the wire
    palette: [stone, grass, air],
    sections: [{ y: 2, single: 0, vox }, { y: 3, single: 1, vox: null }, { y: 4, single: 1, vox: null }],
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, classicSections: false,
  })));
  // The writer collapses a section that repeats one state; expand it again to get the identical
  // voxel grid in longhand form.
  const longhand = {
    ...chunk,
    sections: chunk.sections.map((s) =>
      (s.single ? { ...s, single: 0, vox: new Uint16Array(4096).fill(s.single - 1) } : s)),   // single is slot+1
  };
  assert.ok(chunk.sections.some((s) => s.single), 'the writer must collapse a solid section');

  // Neighbour lookups have to resolve inside the chunk itself, or the comparison measures nothing:
  // a stone block beside a stone block is culled either way, and that is exactly the decision the
  // uniform-section shortcut replaces.
  const inside = (ch) => (cx, cz, lx, ly, lz) => {
    if (cx !== ch.cx || cz !== ch.cz) return -1;                  // unknown outside: show the face
    const sec = ch.sectionAt(ly);
    if (!sec) return -1;
    const slot = sec.single ? sec.single - 1 : sec.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)];
    const id = ch.palette[slot];
    return id === 0 ? -1 : id - 1;
  };
  const a = meshChunk(assets, chunk, inside(chunk), { ao: true });
  const b = meshChunk(assets, longhand, inside(longhand), { ao: true });
  for (let i = 0; i < 3; i++) {
    assert.equal(a.streams[i].count, b.streams[i].count, `pass ${i} vertex count differs`);
    assert.deepEqual([...a.streams[i].position], [...b.streams[i].position], `pass ${i} positions differ`);
    assert.deepEqual([...a.streams[i].uv], [...b.streams[i].uv], `pass ${i} texture differs`);
    assert.deepEqual([...a.streams[i].color], [...b.streams[i].color], `pass ${i} shading differs`);
  }
  assert.ok(a.stats.faces > 200, `expected faces to be emitted, got ${a.stats.faces}`);
  console.log(`# uniform-section fast path: ${a.stats.faces} faces, ${a.stats.culled} culled, ${a.stats.air} air`);
});
