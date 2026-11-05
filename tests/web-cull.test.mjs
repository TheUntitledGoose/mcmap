// M10: the faces that are not worth drawing, and the ones that are.
//
// Two rules live in web/js/mesher.js that are easy to write and easy to get catastrophically wrong:
//
//   * **buried** - a face under the surface skin with no skylight in the air it looks into. This is
//     the lava-pool case: the cavern *is* lit, by the lava, so the dark test lets every face through,
//     and no camera above ground will ever see any of them. The trap is the ravine, which is deep,
//     open, and the first thing you look at.
//   * **covered** - a face pointing at a chunk nobody holds but the heightmap skin already paints.
//
// Both run through the real browser mesher against chunks built by the real server encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk, NEIGH_COVERED } from '../web/js/mesher.js';
import { decodeChunk, packChunk, buildStateIds } from '../server/chunk-payload.mjs';
import { combineLight, lightLevels } from '../shared/light.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, toArrayBuffer(fs.readFileSync('build/assets/geometry.bin')));
const stateIds = buildStateIds(atlas.states.map((s) => s.k));

const air = { Name: 'minecraft:air' };
const stone = { Name: 'minecraft:stone' };
const cellIdx = (lx, ly, lz) => (ly << 8) | (lz << 4) | lx;

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

/**
 * One all-stone chunk at (0,0) whose section spans y 0..15.
 *
 * `holes` lists cells left as air, `surface` gives the WORLD_SURFACE height per column (the array is
 * what the buried test reads, and it arrives through the payload like any other chunk field), and
 * `sky`/`blk` are the light the save would carry.
 */
function makeChunk({ holes = [], surface = 16, sky = 0, blk = 15 } = {}) {
  const bits = 4;
  const data = new BigUint64Array(Math.ceil(4096 * bits / 64));
  const skip = new Set(holes.map(([x, y, z]) => cellIdx(x, y, z)));
  for (let i = 0; i < 4096; i++) if (!skip.has(i)) {
    const bit = i * bits;
    data[bit >> 6] |= 1n << BigInt(bit & 63);
  }
  const nbt = {
    xPos: 0, zPos: 0, yPos: 0, DataVersion: 3465,
    sections: [{
      Y: 0,
      block_states: { palette: [air, stone], data },
      SkyLight: lightArr(sky), BlockLight: lightArr(blk),
    }],
  };
  const ch = openChunk(toArrayBuffer(packChunk(decodeChunk(nbt, stateIds))));
  // The fixture sets the surface skin directly: the heightmap itself is covered by the payload
  // tests, and what matters here is what the mesher reads out of it.
  ch.height = new Uint16Array(256).fill(HEIGHT_BIAS + surface);
  return ch;
}

/** Neighbour probes over one chunk: nothing else is held, so every cross-border lookup is unknown. */
function probes(ch, { covered = false } = {}) {
  const get = (cx, cz) => (cx === 0 && cz === 0 ? ch : null);
  const at = (cx, cz, lx, ly, lz) => {
    const c = get(cx + (lx >> 4), cz + (lz >> 4));
    if (!c) return covered ? NEIGH_COVERED : -1;
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
  const sky = (cx, cz, lx, ly, lz) => {
    const c = get(cx + (lx >> 4), cz + (lz >> 4));
    if (!c) return -1;
    const lv = lightLevels(c.sectionAt, lx, ly, lz);
    return lv ? lv[0] : -1;
  };
  return { at, light, sky };
}

const litOpts = (extra = {}) => ({ lightOn: 1, darkFloor: 0.32, darkGamma: 1, skyScale: 1, ...extra });

test('buried: a lava-lit cavern is lit, so only the skylight test removes it', () => {
  // One air cell 11 blocks under the surface, block light 15 (a lava pool), skylight 0.
  const ch = makeChunk({ holes: [[8, 5, 8]], surface: 16, sky: 0, blk: 15 });
  const p = probes(ch);
  const opts = litOpts({ at: undefined, light: p.light, sky: p.sky, darkcut: 0, buried: 0 });
  const plain = meshChunk(assets, ch, p.at, opts);
  assert.equal(plain.stats.darkCulled, 0, 'the dark rule alone misses every face of it');

  const deep = meshChunk(assets, ch, p.at, { ...opts, buried: 4 });
  assert.equal(deep.stats.buried, 6, 'the six faces around the air cell are all under the skin');
  assert.equal(plain.stats.faces - deep.stats.faces, 6, 'and that is six faces of geometry saved');
  assert.equal(deep.stats.darkCulled, 0, 'saved by the buried rule, not by the dark one');
});

test('buried: skylight reaching the air cell means it is not underground', () => {
  // The same hole, but the cell has sky: an open overhang, a cave mouth, a quarry.
  const ch = makeChunk({ holes: [[8, 5, 8]], surface: 16, sky: 15, blk: 15 });
  const p = probes(ch);
  const out = meshChunk(assets, ch, p.at, litOpts({ light: p.light, sky: p.sky, darkcut: 0, buried: 4 }));
  assert.equal(out.stats.buried, 0, 'a face under rock but open to the sky is drawn');
  assert.ok(out.stats.faces > 0, 'and it is in the mesh');
});

test('buried: a ravine keeps its walls, because its own column is that low', () => {
  // A three-wide slot cut from y5 to the top. The neighbouring columns stand 11 blocks higher, so a
  // "am I below the highest block nearby?" test would bury the whole canyon. The surface *of the
  // slot's own columns* is at y5, which is what the rule reads.
  const holes = [];
  for (let y = 5; y <= 15; y++) for (let x = 7; x <= 9; x++) holes.push([x, y, 8]);
  const ch = makeChunk({ holes, surface: 16, sky: 15, blk: 0 });
  const p = probes(ch);
  const out = meshChunk(assets, ch, p.at, litOpts({ light: p.light, sky: p.sky, darkcut: 0, buried: 4 }));
  assert.equal(out.stats.buried, 0, 'the canyon walls face sky-lit air and are kept');
});

test('buried: the heightmap decides who pays, so a surface face never asks the sky', () => {
  const ch = makeChunk({ surface: 16, sky: 15, blk: 15 });   // solid to the top of the section
  const p = probes(ch);
  let skyCalls = 0;
  const sky = (...a) => { skyCalls++; return p.sky(...a); };
  const out = meshChunk(assets, ch, p.at, litOpts({ light: p.light, sky, darkcut: 0, buried: 4 }));
  assert.equal(out.stats.buried, 0, 'the sky reaches everything here');
  // 256 = the underside of the chunk, 17 blocks under the skin, and the only faces that had to be
  // asked. All 256 top faces were answered by one subtract on the heightmap.
  assert.equal(skyCalls, 256, 'only cells under the skin get a skylight probe');
});

test('buried: without the caves switch off, nothing is culled at all', () => {
  const ch = makeChunk({ holes: [[8, 5, 8]], surface: 16, sky: 0, blk: 15 });
  const p = probes(ch);
  const caves = meshChunk(assets, ch, p.at, litOpts({ light: p.light, sky: p.sky, darkcut: -1, buried: 4 }));
  assert.equal(caves.stats.buried, 0, 'the buried rule belongs to the same switch as the dark one');
  assert.equal(caves.stats.darkCulled, 0);
});

test('buried: a chunk with no heightmap cannot guess, so it draws its faces', () => {
  const ch = makeChunk({ holes: [[8, 5, 8]], surface: 16, sky: 0, blk: 15 });
  ch.height = null;
  const p = probes(ch);
  const out = meshChunk(assets, ch, p.at, litOpts({ light: p.light, sky: p.sky, darkcut: 0, buried: 4 }));
  assert.equal(out.stats.buried, 0, 'no skin to read means no claim about what is underground');
});

test('covered: an unloaded neighbour the far layers paint is not a wall of dirt', () => {
  const ch = makeChunk({ surface: 16, sky: 15, blk: 15 });
  const open = probes(ch);                       // every cross-border lookup answers "unknown"
  const bare = meshChunk(assets, ch, open.at, litOpts({ light: open.light, darkcut: -1 }));
  assert.equal(bare.stats.covered, 0);
  // A solid 16x16x16 chunk with nothing around it: top, bottom, and four side walls.
  assert.equal(bare.stats.faces, 6 * 256, 'with nobody on the other side, the sides are drawn');

  const cov = probes(ch, { covered: true });     // ... unless the heightmap skin covers that side
  const hidden = meshChunk(assets, ch, cov.at, litOpts({ light: cov.light, darkcut: -1 }));
  assert.equal(hidden.stats.covered, 4 * 256, 'four side walls are behind the skin');
  assert.equal(hidden.stats.faces, 2 * 256, 'top and bottom stay: nothing paints above or below');
});

test('covered: unknown is still unknown, and faces there are kept', () => {
  const ch = makeChunk({ surface: 16, sky: 15, blk: 15 });
  const open = probes(ch);
  const out = meshChunk(assets, ch, open.at, litOpts({ light: open.light, darkcut: -1 }));
  assert.equal(out.stats.unknown, 0);
  assert.ok(out.stats.faces > 256, 'a chunk that may yet grow a neighbour keeps its faces');
});
