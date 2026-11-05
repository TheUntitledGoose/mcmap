// The baked coarse LOD layer: the file format, and the one property that makes it safe to serve -
// a baked tile is byte-for-byte what the browser's live far mesher would have made for that region at
// that cell size. If those ever drift, the far view changes shape on a re-bake and nobody can tell why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeLodTile, openLodTile, policyMatches, policyMismatch, LOD_HEADER, LOD_CELL, LOD_BYTES_PER_VERT } from '../shared/lod-format.mjs';
import { lodFileBytes, loadLodTile, listLodTiles, lodPath } from '../server/lod-pack.mjs';
import { atlasStamp, ShellPack } from '../server/shell-pack.mjs';
import { shellFrameCols } from '../server/shell.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';

const ASSETS = path.join('build', 'assets');
const PACKS = path.join('build', 'shells');
const LODS = path.join('build', 'lods');
const POLICY = {
  groundFar: 1, waterOpacity: 0.72, aoFar: 0.949, lightOn: true,
  darkFloor: 0.32, darkGamma: 0.72, skyScale: 1,
};

test('lod tile round trips through the file format', () => {
  const pos = new Float32Array([0, 70, 0, 16, 70, 0, 16, 70, 16, 0, 70, 16]);
  const col = new Uint8Array([10, 20, 30, 255, 11, 21, 31, 255, 12, 22, 32, 255, 13, 23, 33, 255]);
  const img = encodeLodTile({ rx: -3, rz: 5, stamp: 0xdeadbeef, pos, col, count: 4, policy: POLICY });
  const t = openLodTile(img.buffer.slice(0), 0, img.length, 0xdeadbeef);
  assert.equal(t.rx, -3);
  assert.equal(t.rz, 5);
  assert.equal(t.verts, 4);
  assert.equal(t.cell, LOD_CELL);
  assert.deepEqual([...t.pos], [...pos]);
  assert.deepEqual([...t.col], [...col]);
  // lightOn is a bit in the header, so the boolean comes back as 1.
  for (const k in POLICY) assert.equal(t.policy[k], POLICY[k] === true ? 1 : POLICY[k], `policy ${k} survived`);
  assert.equal(policyMatches(t, POLICY), null, 'the shipped policy matches itself');
});

test('a tile the current build must not draw is refused, not misread', () => {
  const pos = new Float32Array(12).fill(1);
  const col = new Uint8Array(16).fill(200);
  const img = encodeLodTile({ rx: 0, rz: 0, stamp: 7, pos, col, count: 4, policy: POLICY });
  const ab = img.buffer.slice(0);
  assert.throws(() => openLodTile(ab, 0, ab.byteLength, 8), /stamp/, 'another atlas');
  const dv = new DataView(ab);
  dv.setUint16(8, 99, true);
  assert.throws(() => openLodTile(ab, 0, ab.byteLength, 7), /version/);
  const short = img.buffer.slice(0, LOD_HEADER + 8);
  assert.throws(() => openLodTile(short, 0, short.byteLength, 7), /truncated|body/);
  const junk = new Uint8Array(LOD_HEADER + 4);
  assert.throws(() => openLodTile(junk.buffer, 0, junk.byteLength, 7), /magic/);
});

test('the far paint a tile was baked with is part of the tile', () => {
  const img = encodeLodTile({ rx: 0, rz: 0, stamp: 1, pos: new Float32Array(3), col: new Uint8Array(4), count: 1, policy: POLICY });
  const t = openLodTile(img.buffer.slice(0));
  assert.equal(policyMatches(t, { ...POLICY, groundFar: 0 }), 'groundFar', 'a different ground rule is a different world');
  assert.equal(policyMatches(t, { ...POLICY, darkFloor: 0.5 }), 'darkFloor');
  assert.equal(policyMatches(t, { ...POLICY, aoFar: 0.95 }), 'aoFar');
  assert.equal(policyMatches(t, { ...POLICY, aoFar: 0.9493 }), null, 'the header quantum is 1/1000');
});

// The class of a disagreement is what decides whether the world is painted at all. Refusing a tile
// because a light slider moved threw away every pre-made tile in the dimension and left the horizon
// to a live mesher that could not keep up.
test('a shading disagreement is reported; only a terrain one refuses the tile', () => {
  const img = encodeLodTile({ rx: 0, rz: 0, stamp: 1, pos: new Float32Array(3), col: new Uint8Array(4), count: 1, policy: POLICY });
  const t = openLodTile(img.buffer.slice(0));
  assert.equal(policyMismatch(t, POLICY), null, 'agreement is not a mismatch');
  for (const k of ['waterOpacity', 'darkFloor', 'darkGamma', 'skyScale', 'lightOn', 'aoFar']) {
    const over = k === 'darkGamma' ? 1.5 : k === 'aoFar' ? 2 : k === 'lightOn' ? false : 0;
    assert.deepEqual(policyMismatch(t, { ...POLICY, [k]: over }), { field: k === 'waterOpacity' ? 'water' : k, kind: 'shade' },
      `${k} only changes how the ground is shaded`);
  }
  assert.deepEqual(policyMismatch(t, { ...POLICY, groundFar: 0 }), { field: 'groundFar', kind: 'geom' },
    'the ground rule decides where the surface is, so that one is fatal');
});

test('a served tile inflates to an image the browser can open', () => {
  const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
  const col = new Uint8Array([9, 9, 9, 255, 8, 8, 8, 255]);
  const file = lodFileBytes({ rx: 2, rz: -9, stamp: 1234, pos, col, count: 2, policy: POLICY });
  const dir = fs.mkdtempSync(path.join('build', 'lodtest-'));
  try {
    const f = lodPath(dir, 2, -9);
    fs.writeFileSync(f, file);
    assert.ok(file.length < LOD_HEADER + 2 * LOD_BYTES_PER_VERT + 40, 'deflate actually shrinks a real body');
    const t = loadLodTile(f, 1234);
    assert.equal(t.verts, 2);
    assert.deepEqual([...t.pos], [...pos]);
    assert.deepEqual([...t.col], [...col]);
    assert.deepEqual(listLodTiles(dir), [{ rx: 2, rz: -9 }]);
    assert.equal(loadLodTile(lodPath(dir, 0, 0), 1234), null, 'absent is absent, not an error');
    assert.throws(() => loadLodTile(f, 999), /stamp/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const havePacks = fs.existsSync(PACKS);
test('a baked region tile equals what the live far mesher makes for it', { skip: !havePacks }, () => {
  const atlasStat = fs.statSync(path.join(ASSETS, 'atlas.json'));
  const atlas = JSON.parse(fs.readFileSync(path.join(ASSETS, 'atlas.json'), 'utf8'));
  const stamp = atlasStamp(atlasStat, atlas.states.length);
  const geo = fs.readFileSync(path.join(ASSETS, 'geometry.bin'));
  const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

  const key = 'dimensions_spellbladenext_glassocean_region';
  const tiles = listLodTiles(path.join(LODS, key));
  assert.ok(tiles.length, 'expected baked tiles for the smallest dimension');
  const { rx, rz } = tiles.find((t) => fs.existsSync(lodPath(path.join(LODS, key), t.rx, t.rz))) ?? {};
  const baked = loadLodTile(lodPath(path.join(LODS, key), rx, rz), stamp);
  assert.ok(baked && baked.verts > 100, `tile ${rx},${rz} should hold geometry`);
  assert.equal(policyMatches(baked, POLICY), null, 'baked with the shipped far paint');

  const packs = new Map();
  const frameAt = new Map();
  const packAt = (x, z) => {
    const k = `${x},${z}`;
    if (!packs.has(k)) packs.set(k, ShellPack.load(path.join(PACKS, key, `${x}_${z}.bin`), stamp));
    return packs.get(k);
  };
  const shellAt = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (frameAt.has(k)) return frameAt.get(k);
    const p = packAt(cx >> 5, cz >> 5);
    const cols = p && p.cols(cx, cz);
    let f = null;
    if (cols) {
      const buf = shellFrameCols(cx, cz, cols.h, cols.cover, cols.g, cols.s, cols.light);
      f = openShellFrame(buf.buffer, 0, buf.length);
    }
    frameAt.set(k, f);
    return f;
  };
  const { stream } = meshShellPatch(assets, shellAt, rx * 32, rz * 32, 32, 32, {
    cell: LOD_CELL, maxSkirt: 24, blend: 1, cap: 1 << 20, ...POLICY,
  });
  assert.equal(stream.count, baked.verts, 'same vertex count as the tile on disk');
  assert.deepEqual([...stream.position], [...baked.pos], 'same positions');
  assert.deepEqual([...stream.color], [...baked.col], 'same colours');
});
