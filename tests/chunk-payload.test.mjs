// Chunk decode tests. Real chunks from the DarkRPG save, with the slow BigInt reader as the
// correctness oracle for the fast two-word reader, a full payload round-trip, and the game's own
// MOTION_BLOCKING heightmap as an independent check that voxels landed where the game put them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import {
  bitsFor, looksClassic, unpackFast, unpackClassic, unpackBigInt,
  decodeChunk, packChunk, openChunk, buildStateIds, HEIGHT_BIAS, LIGHT_VARIES,
} from '../server/chunk-payload.mjs';
import { WorldService, BATCH_MAGIC } from '../server/world-service.mjs';
import { stateKey } from '../shared/state-key.mjs';

const WORLD = 'DarkRPG/world';
const haveWorld = existsSync(`${WORLD}/region/r.0.0.mca`);
const censusKeys = () => JSON.parse(readFileSync('build/census.json', 'utf8')).states.map(s => s.key);

// ---- synthetic bit packing ------------------------------------------------------------------

test('fast reader matches the BigInt reader for every palette width (modern layout)', () => {
  for (const bits of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18]) {
    const count = 4096;
    const longs = new Array(Math.ceil(count * bits / 64)).fill(0n).map((_, i) => {
      // deterministic pseudo-random values, kept inside 64 bits (that is what a long is)
      let x = BigInt(i * 2654435761 + bits * 97) & 0xffffffffn;
      x = (x << 32n) | BigInt((i * 40503 + 12345) & 0xffffffff);
      return (x ^ (x << 13n) ^ (x >> 7n)) & 0xffffffffffffffffn;
    });
    assert.deepEqual(Array.from(unpackFast(longs, bits, count)),
      Array.from(unpackBigInt(longs, bits, count)), `bits=${bits}`);
  }
});

test('classic (pre-1.16.220) padded layout stays inside its long', () => {
  for (const bits of [4, 5, 6, 7, 8, 9, 12, 13, 14]) {
    const count = 4096, per = Math.floor(64 / bits);
    const longs = new Array(Math.ceil(count / per)).fill(0n).map((_, i) => {
      let v = 0n;
      for (let k = 0; k < per; k++) v |= BigInt((i * 31 + k * 7) % (1 << bits)) << BigInt(k * bits);
      return v;
    });
    assert.deepEqual(Array.from(unpackClassic(longs, bits, count)),
      Array.from(unpackBigInt(longs, bits, count, true)), `classic bits=${bits}`);
    for (let i = 0; i < count; i++) assert.ok((i % per) * bits + bits <= 64, 'entry straddles its long');
  }
});

test('single-value sections need no data array', () => {
  assert.equal(bitsFor(1), 0);
  assert.equal(bitsFor(1, true), 4);
  assert.deepEqual(Array.from(unpackFast([], 0, 8)), new Array(8).fill(0));
});

test('layout sniffing reads the content, not the array length', () => {
  // Some writers here emit more longs than the packing needs, so only the content settles it:
  // the padded layout leaves the top bits of every long empty, the modern one fills them.
  for (const bits of [3, 5, 6, 7, 9, 10, 11, 13, 14]) {
    const per = Math.floor(64 / bits);
    if (per * bits === 64) { assert.equal(looksClassic([0xffffffffffffffffn], bits), false); continue; }
    const modern = new Array(40).fill(0n);
    for (let i = 0; i < 40; i++) modern[i] = (0x7fffffffffffffffn << BigInt(i & 7)) | 1n << BigInt(per * bits);
    assert.equal(looksClassic(modern, bits), false, `bits=${bits} modern`);
    const padded = [];
    for (let i = 0; i < 40; i++) {
      let v = 0n;
      for (let k = 0; k < per; k++) v |= BigInt((i * 7 + k * 3) % (1 << bits)) << BigInt(k * bits);
      padded.push(v);
    }
    assert.equal(looksClassic(padded, bits), true, `bits=${bits} padded`);
    // one straddling entry anywhere flips the verdict
    padded[17] |= 1n << BigInt(per * bits);
    assert.equal(looksClassic(padded, bits), false, `bits=${bits} one straddle`);
  }
});

// ---- real chunks ----------------------------------------------------------------------------

const REGION = `${WORLD}/region/r.0.0.mca`;

function realChunk(x = 3, z = 3) {
  const rgn = new RegionFile(REGION);
  const raw = rgn.readChunkNbtBytes(x, z);
  rgn.close();
  assert.ok(raw, 'chunk stream missing');
  return readNbt(zlib.inflateSync(raw)).value;
}

test('real chunk: payload palette indices match the BigInt oracle exactly', { skip: !haveWorld }, () => {
  const nbt = realChunk();
  const stateIds = buildStateIds(censusKeys());
  const decoded = decodeChunk(nbt, stateIds);
  assert.ok(decoded, 'decode returned null');
  const ys = nbt.sections
    .filter(s => s.block_states?.palette?.length ?? s.BlockStatePalette?.length)
    .map(s => Number(s.Y));
  assert.equal(decoded.yMin, Math.min(...ys));
  assert.ok(decoded.yCount >= 16, `unexpected section span ${decoded.yMin}..${decoded.yMin + decoded.yCount - 1}`);

  const open = openChunk(packChunk(decoded));
  assert.equal(open.cx, decoded.cx);
  assert.equal(open.cz, decoded.cz);
  assert.equal(decoded.badPaletteIndices, 0, 'decoded indices ran past the palette');

  let checked = 0, unknown = 0;
  const layouts = { modern: 0, classic: 0 };
  for (const sec of nbt.sections) {
    const y = Number(sec.Y);
    const pal = sec.block_states?.palette ?? sec.BlockStatePalette;
    if (!pal?.length) continue;                       // starlight-only sections carry no blocks
    const data = (sec.block_states?.data ?? sec.BlockStates ?? []).map(d => BigInt(d));
    const classicStored = !sec.block_states && !!sec.BlockStatePalette;
    const bits = bitsFor(pal.length, classicStored);
    const s = open.sectionAt(y * 16);            // sectionAt takes a block y
    assert.ok(s, `payload has no section y=${y}`);
    const ids = pal.map(p => stateIds.get(stateKey(p.Name, p.Properties)) ?? 0);
    ids.forEach(id => { if (!id) unknown++; });

    if (bits === 0) {
      assert.ok(s.single, 'single-value section is not flagged uniform');
      assert.equal(s.single - 1, open.palette.indexOf(ids[0]));
      checked += 4096;
      continue;
    }
    const modern = unpackBigInt(data, bits, 4096, false);
    const padded = unpackBigInt(data, bits, 4096, true);
    const gotArr = s.vox;                             // palette slot per voxel, in NBT x + z*16 + y*256 order
    const predicted = looksClassic(data, bits);
    // the payload must agree with the packing the content implies, and with nothing else
    const agree = (ref) => ref.every((v, i) => (v < ids.length ? ids[v] : 0) === open.palette[gotArr[i]]);
    assert.ok(agree(predicted ? padded : modern),
      `section y=${y} does not match the ${predicted ? 'padded' : 'modern'} packing its content implies`);
    if (agree(padded) !== agree(modern)) layouts[predicted ? 'classic' : 'modern']++;
    checked += 4096;
  }
  assert.ok(checked > 50_000, `only ${checked} voxels checked`);
  console.log(`  sections where the two packings differ here: modern=${layouts.modern} classic=${layouts.classic}`);
  assert.equal(unknown, 0, 'some palette entries have no census state id');
});

test('stateAt() reads voxels at the coordinates the mesher will use', { skip: !haveWorld }, () => {
  const nbt = realChunk();
  const stateIds = buildStateIds(censusKeys());
  const open = openChunk(packChunk(decodeChunk(nbt, stateIds)));
  // cross-check a few positions against the section arrays directly
  for (const s of open.sections) {
    for (const [x, z] of [[0, 0], [15, 0], [0, 15], [15, 15], [7, 3]]) {
      for (const ly of [0, 5, 15]) {
        const y = s.y * 16 + ly;
        assert.ok(open.sectionAt(y) === s, `sectionAt(${y})`);
        const viaIndex = open.palette[s.single ? s.single - 1 : s.vox[(ly << 8) | (z << 4) | x]];
        assert.equal(open.stateAt(x, y, z), viaIndex, `stateAt(${x},${y},${z})`);
      }
    }
  }
  assert.equal(open.stateAt(0, 1e6, 0), 0, 'outside the chunk must read as air');
});

test('decoded voxels agree with the game’s own heightmaps', { skip: !haveWorld }, () => {
  // Heightmaps are computed by the server from the real voxels, so they are an oracle that never
  // touches our bit unpacking: misread palette indices or a wrong voxel order move the tops.
  const nbt = realChunk();
  const keys = censusKeys();
  const stateIds = buildStateIds(keys);
  const keyOf = new Map(keys.map((k, i) => [i + 1, k]));
  const open = openChunk(packChunk(decodeChunk(nbt, stateIds)));
  assert.ok(open.height, 'no WORLD_SURFACE heightmap in the payload');
  assert.ok(open.heightMotion, 'no MOTION_BLOCKING heightmap in the payload');

  const yFloor = open.yMin * 16, yCeil = (open.yMin + open.yCount) * 16;
  for (const h of [...open.height, ...open.heightMotion]) {
    const abs = h - HEIGHT_BIAS;
    assert.ok(abs >= yFloor - 1 && abs <= yCeil, `heightmap value ${abs} outside the chunk span ${yFloor}..${yCeil}`);
  }

  const topAt = (x, z) => {
    for (let si = open.sections.length - 1; si >= 0; si--) {
      const s = open.sections[si];
      for (let ly = 15; ly >= 0; ly--) {
        const id = open.palette[s.single ? s.single - 1 : s.vox[(ly << 8) | (z << 4) | x]];
        const key = keyOf.get(id) ?? '';
        if (id && !/air|void/.test(key)) return s.y * 16 + ly;
      }
    }
    return null;
  };

  // WORLD_SURFACE counts every block the game considers non-air. Where the two disagree the game
  // is the one that stops lower: Regions Unexplored leaves do not count for its heightmaps, so our
  // canopy top sits above it. It must never sit below our top, which would mean lost voxels.
  let exact = 0, oursHigher = 0, lost = [];
  for (let i = 0; i < 256; i++) {
    const t = topAt(i & 15, (i >> 4) & 15);
    const want = open.height[i] - HEIGHT_BIAS;
    if (t === null) { if (want < yFloor) exact++; else if (lost.length < 6) lost.push(`empty col (${i & 15},${(i >> 4) & 15}) ws=${want}`); }
    else if (t === want) exact++;
    else if (t > want) oursHigher++;                   // game ignores this block type
    else if (lost.length < 6) lost.push(`(${i & 15},${(i >> 4) & 15}) top=${t} ws=${want}`);
  }
  console.log(`  column tops vs WORLD_SURFACE: exact=${exact}/256, ours-higher=${oursHigher}`);
  assert.equal(lost.length, 0, `voxels above the game's heightmap are missing: ${lost.join(' ')}`);
  assert.ok(exact >= 120, `only ${exact}/256 columns match WORLD_SURFACE - voxel order is suspect`);

  // MOTION_BLOCKING follows vanilla's "blocks motion" predicate and sits below the canopy; keep it
  // as a bounded check that the array is at least the same landscape.
  let far = 0;
  for (let i = 0; i < 256; i++) {
    const t = topAt(i & 15, (i >> 4) & 15) ?? yFloor;
    if (Math.abs(t - (open.heightMotion[i] - HEIGHT_BIAS)) > 32) far++;
  }
  assert.equal(far, 0, 'MOTION_BLOCKING disagrees with the voxels by more than a canopy');
});

test('a bad NBT position never moves the chunk', { skip: !haveWorld }, () => {
  const nbt = realChunk();
  nbt.xPos = 0; nbt.zPos = 0;                        // the legacy (0,0) bug this world really has
  const svc = new WorldService(WORLD, buildStateIds(censusKeys()), null);
  const bytes = svc.chunkBytes('minecraft:overworld', 3, 3);
  const open = openChunk(bytes);
  assert.equal(open.cx, 3, 'payload position came from the NBT, not the region header');
  assert.equal(open.cz, 3);
});

// ---- service / cache ------------------------------------------------------------------------

test('WorldService decodes, caches and re-serves identical bytes', { skip: !haveWorld }, () => {
  rmSync('build/cache-test', { recursive: true, force: true });
  const svc = new WorldService(WORLD, buildStateIds(censusKeys()), 'build/cache-test');
  const dims = svc.dimList();
  assert.ok(dims.some(d => d.id === 'minecraft:overworld'));
  assert.ok(dims.some(d => d.id === 'minecraft:the_nether'));
  assert.ok(dims.some(d => d.id === 'spellbladenext:glassocean'), 'custom dimension not registered');

  const a = svc.chunkBytes('minecraft:overworld', 3, 3);
  assert.ok(a?.length > 1000, 'payload suspiciously small');
  const hitsBefore = svc.stats.cacheHits;
  const b = svc.chunkBytes('minecraft:overworld', 3, 3);
  assert.equal(svc.stats.cacheHits, hitsBefore + 1, 'second read did not hit the cache');
  assert.deepEqual(a, b, 'cached payload differs from decoded payload');

  // short dimension names resolve; an ungenerated position has no payload
  assert.ok(svc.chunkBytes('overworld', 3, 3));
  assert.equal(svc.chunkBytes('minecraft:overworld', 4000, 4000), null);

  const cont = svc.batchBytes('minecraft:overworld', 2, 2, 3, 2);
  assert.equal(cont.subarray(0, 8).toString('ascii'), BATCH_MAGIC);
  assert.equal(cont.readUInt32LE(8), 6);
  let p = 12, frames = 0;
  for (let i = 0; i < 6; i++) {
    const len = cont.readUInt32LE(p); p += 4;
    if (len) { const c = openChunk(cont.subarray(p, p + len)); assert.ok(c.palette.length > 0); frames++; }
    p += (len + 3) & ~3;                              // frames are padded to view alignment
  }
  assert.equal(frames, 6, 'a batch frame was unexpectedly empty');
  assert.equal(p, cont.length, 'batch container length drift');

  // nether + custom dimension decode through the same path
  const nether = svc.chunkBytes('minecraft:the_nether', 0, 0);
  assert.ok(nether?.length > 1000, 'nether chunk payload missing');
  openChunk(nether);
});
test('payload v3 carries light: flat sections, varying arrays, and the heightmap rule', () => {
  const nib = (fill) => {                       // vanilla nibble order: index i -> byte i>>1
    const a = new Uint8Array(2048);
    if (typeof fill === 'number') a.fill((fill & 15) | ((fill & 15) << 4));
    else for (let i = 0; i < 4096; i++) { const v = fill(i) & 15, at = i >> 1; a[at] = i & 1 ? (a[at] & 0x0f) | (v << 4) : (a[at] & 0xf0) | v; }
    return a;
  };
  const hmArr = (stored) => {                   // 256 entries of `bits` bits, packed back to back
    const bits = 6, out = new BigUint64Array(Math.ceil(256 * bits / 64));
    for (let i = 0; i < 256; i++) {
      const bit = i * bits;
      out[bit >> 6] |= BigInt(stored) << BigInt(bit & 63);
      if ((bit & 63) + bits > 64) out[(bit >> 6) + 1] |= BigInt(stored) >> BigInt(64 - (bit & 63));
    }
    return out;
  };
  const air = { Name: 'minecraft:air' }, stone = { Name: 'minecraft:stone' };
  // yPos 1 => sections cover y 16..47; a stored height of 5 means world top 20, so section Y=2 (y>=32)
  // is open sky and section Y=1 straddles the surface.
  const mk = () => ({
    xPos: 0, zPos: 0, yPos: 1, DataVersion: 3465,
    sections: [
      { Y: 1, block_states: { palette: [air, stone], data: new BigUint64Array(256) },
        SkyLight: nib(3), BlockLight: nib((i) => i % 16) },
      { Y: 2, block_states: { palette: [air], data: new BigUint64Array(256) } },
    ],
    Heightmaps: { WORLD_SURFACE: hmArr(5), MOTION_BLOCKING: hmArr(5) },
  });
  const stateIds = buildStateIds(['minecraft:air', 'minecraft:stone']);

  const open = openChunk(packChunk(decodeChunk(mk(), stateIds)));
  assert.equal(open.sections.length, 2);
  const [low, high] = open.sections;
  // a completely flat array (sky = 3 everywhere) collapses to the level and costs no bytes;
  // block light that actually varies travels as the real nibble array
  assert.equal(low.sky, 3, 'a uniform sky array collapses to its level');
  assert.equal(low.blk, LIGHT_VARIES, 'varying block light travels as an array');
  assert.equal(open.lightAt(0, 16, 0)[0], 3, 'flat sky reads back as a level');
  assert.equal(open.lightAt(3, 16, 0)[1], 3, 'nibble order is index i -> byte i>>1');
  assert.equal(open.lightAt(17, 16, 0)[1], 1, 'varying block light decodes nibble by nibble');
  assert.equal(high.sky, 15, 'an unmarked section above the heightmap top is open sky');
  assert.equal(high.blk, 0, 'and unlit by torches');
  assert.equal(open.surfaceAt(0, 0), 20, 'the heightmap still means what it used to');
  // two code bytes per section, plus the one array that genuinely varies: 2048 + 4 bytes
  assert.equal(packChunk(decodeChunk(mk(), stateIds)).length -
    packChunk(decodeChunk(mk(), stateIds, { light: false })).length, 2048 + 4,
    'flat sections cost 2 bytes each, a varying section costs its array');

  const neth = openChunk(packChunk(decodeChunk(mk(), stateIds, { dimHasSky: false })));
  assert.equal(neth.sections[1].sky, 0, 'no skylight in a dimension that has none');

  const dark = mk();
  dark.sections = [{ Y: 1, block_states: { palette: [air, stone], data: new BigUint64Array(256) },
    'starlight.skylight_state': 1, 'starlight.blocklight_state': 1 }];
  const dk = openChunk(packChunk(decodeChunk(dark, stateIds)));
  assert.deepEqual([dk.sections[0].sky, dk.sections[0].blk], [0, 0], 'Starlight marker 1 = uniform zero');
});
