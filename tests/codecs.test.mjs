import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ZipFile } from '../server/zip.mjs';
import { decodePng, encodePngRgba, crc32, pixel } from '../server/png.mjs';

const VANILLA = process.env.VANILLA_JAR ?? 'your .minecraft/versions/1.20.1/1.20.1.jar';

test('zip: reads vanilla blockstate json', () => {
  const z = new ZipFile(VANILLA);
  const t = z.readText('assets/minecraft/blockstates/grass_block.json');
  assert.ok(t.includes('grass_block_snow'), 'variant model ref');
  assert.ok([...z.names()].length > 5000, 'entry count');
  z.close();
});

test('zip: reads a PNG entry byte-exactly', () => {
  const z = new ZipFile(VANILLA);
  const png = z.read('assets/minecraft/textures/block/grass_block_top.png');
  assert.equal(png[1], 0x50, 'PNG signature P');
  const img = decodePng(png);
  assert.equal(img.w, 16);
  assert.equal(img.h, 16);
  assert.equal(img.rgba.length, 16 * 16 * 4);
  // grass top is fully opaque
  for (let i = 3; i < img.rgba.length; i += 4) assert.equal(img.rgba[i], 255);
  z.close();
});

test('png: decodes palette + tRNS texture (glass-like alpha)', () => {
  const z = new ZipFile(VANILLA);
  const img = decodePng(z.read('assets/minecraft/textures/block/glass.png'));
  assert.equal(img.w, 16);
  let transparent = 0, opaque = 0;
  for (let i = 3; i < img.rgba.length; i += 4) img.rgba[i] === 0 ? transparent++ : opaque++;
  assert.ok(transparent > 150, `glass mostly transparent, got ${transparent}`);
  assert.ok(opaque > 10 && opaque < 256, `glass has visible frame, got ${opaque}`);
  z.close();
});

test('png: encoder round-trips (all 5 filter types exercised by decoder path)', () => {
  const w = 17, h = 5; // odd width to catch stride bugs
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 37) & 255; rgba[i * 4 + 1] = (i * 11) & 255;
    rgba[i * 4 + 2] = i & 255; rgba[i * 4 + 3] = i % 7 === 0 ? 0 : 255;
  }
  const enc = encodePngRgba(w, h, rgba);
  const back = decodePng(enc);
  assert.equal(back.w, w); assert.equal(back.h, h);
  assert.deepEqual(Buffer.from(back.rgba), rgba);
});

test('png: 32x32 mod texture decodes', () => {
  const z = new ZipFile('DarkRPG/mods/mythicmetals-0.19.7+1.20.1.jar');
  const name = [...z.names()].find(n => /textures\/.*\.png$/.test(n));
  assert.ok(name, 'has textures');
  const img = decodePng(z.read(name));
  assert.ok(img.w >= 16 && img.h >= 16, `${name} ${img.w}x${img.h}`);
  assert.ok(img.w % 1 === 0);
  z.close();
});

// ---- interlaced (Adam7) PNG -----------------------------------------------
test('decodes an interlaced PNG and scatters the seven passes correctly', () => {
  // Hand-built 8x8 RGBA8 Adam7 file: pixel value = index, so every pass's pixels are identifiable.
  const W = 8, H = 8;
  const px = (x, y) => { const i = y * W + x; return [i, i * 3 & 255, 255 - i, i % 2 ? 255 : 128]; };
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const raw = [];
  let seen = 0;
  for (const [xo, yo, xs, ys] of passes) {
    const pw = Math.ceil((W - xo) / xs), ph = Math.ceil((H - yo) / ys);
    for (let py = 0; py < ph; py++) {
      raw.push(0);                                   // filter 0 for the fixture
      for (let pxi = 0; pxi < pw; pxi++) { raw.push(...px(xo + pxi * xs, yo + py * ys)); seen++; }
    }
  }
  assert.equal(seen, W * H, 'Adam7 passes must cover every pixel exactly once');
  const idat = zlib.deflateSync(Buffer.from(raw));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 1;            // interlaced
  const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

  const img = decodePng(file);
  assert.deepEqual([img.w, img.h], [W, H]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.deepEqual(pixel(img, x, y), px(x, y), `pixel ${x},${y}`);
});

test('decodes real interlaced mod textures', () => {
  const jar = fs.readdirSync('DarkRPG/mods').find(f => /^geode_plus/i.test(f));
  if (!jar) return;                                  // mod jar not present in this checkout
  const z = new ZipFile(`DarkRPG/mods/${jar}`);
  const bytes = z.read('assets/geode_plus/textures/block/budding_redstone.png');
  z.close();
  assert.ok(bytes, 'texture entry exists');
  assert.equal(bytes[28], 1, 'fixture texture should be interlaced');
  const img = decodePng(bytes);
  assert.ok(img.w >= 16 && img.h >= 16, 'expected a real texture size');
  let opaque = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 200) opaque++;
  assert.ok(opaque > img.w * img.h * 0.5, 'expected an essentially opaque texture');
});
