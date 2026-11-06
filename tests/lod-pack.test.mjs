// The baked coarse LOD layer: the file format, and the one property that makes it safe to serve -
// a baked tile is byte-for-byte what the browser's live far mesher would have made for that region at
// that cell size. If those ever drift, the far view changes shape on a re-bake and nobody can tell why.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeLodTile, openLodTile, policyMatches, policyMismatch, LOD_HEADER, LOD_CELL, LOD_BYTES_PER_VERT } from '../shared/lod-format.mjs';
import { lodFileBytes, loadLodTile, listLodTiles, lodPath, summarizeLodDir } from '../server/lod-pack.mjs';
import { LOD_CELLS, pickLodCell } from '../shared/lod-format.mjs';
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
  caps: true, capDrop: 4,
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
  // Caps are geometry too: a tile baked without them draws every canopy as a column down to the ground,
  // which is the exact bug the skin byte exists to fix.
  assert.deepEqual(policyMismatch(t, { ...POLICY, caps: false }), { field: 'caps', kind: 'geom' },
    'a tile without surface skin is a different shape of world');
  assert.deepEqual(policyMismatch(t, { ...POLICY, capDrop: 2 }), { field: 'capDrop', kind: 'geom' },
    'and which skins got drawn is baked in, not a live preference');
});

test('the ladder: a rung is asked for when its columns still measure something', () => {
  // pxPerBlock = 1/40: at cell 16 a column is 0.4 px, at cell 4 it is 0.1 px. Neither clears 3 px, so
  // the coarse rung is the answer - painted ground beats an unpainted horizon.
  assert.equal(pickLodCell([4, 16], 1 / 40, 3), 16, 'nothing measures up: take the cheap rung');
  // 1 px/block: cell 16 measures 16 px, cell 4 measures 4 px. Both clear 3, so take the finer one.
  assert.equal(pickLodCell([4, 16], 1, 3), 4, 'both fit: take the finer one');
  // 0.2 px/block: cell 16 is 3.2 px (fits), cell 4 is 0.8 px (does not).
  assert.equal(pickLodCell([4, 16], 0.2, 3), 16, 'only the coarse rung is worth a triangle');
  // A finer rung already in RAM stays even when it is no longer needed: it is already paid for, and
  // dropping it would cost a dispose plus a re-fetch the next time the view wants it back.
  assert.equal(pickLodCell([4, 16], 1, 3, 4), 4, 'held finer stays');
  // A finer rung already in RAM stays: it is already paid for, and dropping it costs a dispose plus a
  // re-fetch the next time the view wants it back.
  assert.equal(pickLodCell([4, 16], 1, 3, 4), 4, 'held finer stays');
  // The visual rule: a 16-block column that measures over the blob bar goes finer even though the fine
  // columns would be small, because a tree inside a 12 px column is a tower. This is the exact case the
  // previous rule refused - it demanded 3.9 px from the fine rung and got 3.04, so the tower stayed.
  assert.equal(pickLodCell([4, 16], 0.76, 3, 16), 4, 'a 12 px column is a blob: go finer');
  assert.equal(pickLodCell([4, 16], 0.5, 3, 16), 16, 'an 8 px column is still ground, leave it');
  // Three rungs: it stops at the first one that is not a blob, rather than leaping to the finest.
  assert.equal(pickLodCell([4, 8, 16], 0.76, 3, 16), 4, 'finest that still measures');
  assert.equal(pickLodCell([4, 8, 16], 0.76, 3, 8), 8, 'an 6 px column does not need the finest rung');
  // Releasing a fine tile you already hold is also a decision: it costs a re-fetch to want it back.
  assert.equal(pickLodCell([4, 16], 0.5, 3, 4), 4, 'a held tile at 2 px stays rather than re-fetch');
  assert.equal(pickLodCell([4, 16], 0.05, 3, 4), 16, 'once it is a twentieth of a pixel it goes');
  assert.equal(pickLodCell([], 10, 3), 0, 'no rungs, no request');
  assert.equal(pickLodCell([16], 100, 3), 16, 'a single-rung dimension still paints');
});

test('/meta must count the baked layer with the reader, not with a folder listing', () => {
  // The bug this pins: worldd used to answer "is there a baked far layer?" by counting *.bin files
  // directly inside build/lods/<dim>. The rungs then moved into c<cell>/ subfolders, that count went
  // to zero, and the browser quietly declined to use 4 GB of baked geometry - no error, no 404, just a
  // slower far view that looked like a performance problem.
  const dir = fs.mkdtempSync(path.join('build', 'lodmeta-'));
  try {
    const write = (cell, rx, rz) => {
      const f = cell ? lodPath(path.join(dir, 'region'), cell, rx, rz) : path.join(dir, 'region', `${rx}_${rz}.bin`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, lodFileBytes({ rx, rz, stamp: 1, pos: new Float32Array(3), col: new Uint8Array(4), count: 1, policy: POLICY }));
    };
    assert.deepEqual(summarizeLodDir(dir), { dims: 0, tiles: 0, cells: [] }, 'an empty tree is a zero, not an error');
    write(0, 1, 2);                                    // the retired flat layout: unreachable, so not counted
    assert.equal(summarizeLodDir(dir).tiles, 0, 'a tile outside a rung folder does not exist');
    write(LOD_CELL, 1, 2); write(4, 1, 2);
    const s = summarizeLodDir(dir);
    assert.deepEqual(s, { dims: 1, tiles: 2, cells: [LOD_CELL, 4] }, 'both rungs counted, both named');
    assert.equal(s.tiles, listLodTiles(path.join(dir, 'region')).length, 'the summary is the reader, summed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // And against the real bake: if tiles are on disk in a layout the reader can see, /meta has to say so.
  if (fs.existsSync(LODS)) {
    const real = summarizeLodDir(LODS);
    const n = fs.readdirSync(LODS).reduce((a, sub) => {
      const d = path.join(LODS, sub);
      return a + (fs.statSync(d).isDirectory() ? listLodTiles(d).length : 0);
    }, 0);
    assert.equal(real.tiles, n, 'the real bake counts the same from both ends');
    if (n) assert.ok(real.dims >= 1 && real.cells.length >= 1, `${n} tiles on disk must not read as absent`);
  }
});

test('a served tile inflates to an image the browser can open', () => {
  const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
  const col = new Uint8Array([9, 9, 9, 255, 8, 8, 8, 255]);
  const file = lodFileBytes({ rx: 2, rz: -9, stamp: 1234, pos, col, count: 2, policy: POLICY });
  const dir = fs.mkdtempSync(path.join('build', 'lodtest-'));
  try {
    const f = lodPath(dir, LOD_CELL, 2, -9);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, file);
    assert.ok(file.length < LOD_HEADER + 2 * LOD_BYTES_PER_VERT + 40, 'deflate actually shrinks a real body');
    const t = loadLodTile(f, 1234);
    assert.equal(t.verts, 2);
    assert.deepEqual([...t.pos], [...pos]);
    assert.deepEqual([...t.col], [...col]);
    assert.deepEqual(listLodTiles(dir), [{ cell: LOD_CELL, rx: 2, rz: -9, verts: 2 }],
      'one file, and it says which rung and what it costs');
    assert.equal(loadLodTile(lodPath(dir, LOD_CELL, 0, 0), 1234), null, 'absent is absent, not an error');
    assert.throws(() => loadLodTile(f, 999), /stamp/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const havePacks = fs.existsSync(PACKS);
test('a baked region tile equals what the live far mesher makes for it', { skip: !havePacks }, (t) => {
  const atlasStat = fs.statSync(path.join(ASSETS, 'atlas.json'));
  const atlas = JSON.parse(fs.readFileSync(path.join(ASSETS, 'atlas.json'), 'utf8'));
  const stamp = atlasStamp(atlasStat, atlas.states.length);
  const geo = fs.readFileSync(path.join(ASSETS, 'geometry.bin'));
  const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

  const key = 'dimensions_spellbladenext_glassocean_region';
  const tiles = listLodTiles(path.join(LODS, key));
  if (!tiles.length) { t.skip(`no baked tiles for ${key} in this layout yet - node server/bake-lod.mjs`); return; }
  // Every rung that exists, because a rung the browser will ask for has to be the one the live mesher
  // would have made. A missing rung is normal (they are baked independently), an unmatched one is not.
  const rungs = [...new Set(tiles.map((t) => t.cell))].sort((a, b) => b - a);
  assert.ok(rungs.length <= LOD_CELLS.length, `rungs ${rungs.join(',')} outside the ladder`);
  for (const cell of rungs) {
    const { rx, rz } = tiles.find((t) => t.cell === cell) ?? {};
    let baked = null;
    try {
      baked = loadLodTile(lodPath(path.join(LODS, key), cell, rx, rz), stamp);
    } catch (e) {
      // A bake from before this format is not a code failure, and the message has to say what to run.
      t.skip(`the baked tiles predate this format (${e.message}) - node server/bake-lod.mjs --force`);
      return;
    }
    assert.ok(baked && baked.verts > 100, `cell ${cell} tile ${rx},${rz} should hold geometry`);
    assert.equal(policyMatches(baked, POLICY), null, `cell ${cell} baked with the shipped far paint`);
    assert.equal(baked.cell, cell, 'and the file says which rung it is');

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
    cell, maxSkirt: 24, blend: 1, cap: 1 << 20, ...POLICY,
  });
  assert.equal(stream.count, baked.verts, `cell ${cell}: same vertex count as the tile on disk`);
  assert.deepEqual([...stream.position], [...baked.pos], `cell ${cell}: same positions`);
  assert.deepEqual([...stream.color], [...baked.col], `cell ${cell}: same colours`);
  }
});
