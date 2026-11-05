// Atlas packer: cells must fit, not overlap, carry a clamped gutter, and the atlas must be
// a power-of-two RGBA buffer the encoder can write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packTextures, textureStats } from '../server/atlas.mjs';

const solid = (w, h, [r, g, b, a]) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a; }
  return { w, h, rgba };
};
const px = (atlas, size, x, y) => {
  const o = (y * size + x) * 4;
  return [atlas[o], atlas[o + 1], atlas[o + 2], atlas[o + 3]];
};

test('atlas: power of two, cells inside bounds, gutter clamped to edge colour', () => {
  const entries = [
    { id: 'a', ...solid(16, 16, [200, 10, 10, 255]) },
    { id: 'b', ...solid(16, 16, [10, 200, 10, 255]) },
    { id: 'c', ...solid(8, 16, [10, 10, 200, 128]) },
    { id: 'd', ...solid(3, 3, [250, 250, 10, 255]) },
  ];
  const { size, cells, rgba } = packTextures(entries, { minSize: 64 });
  assert.ok(rgba instanceof Uint8Array, 'packed atlas pixels returned');
  assert.equal(rgba.length, size * size * 4);
  assert.ok((size & (size - 1)) === 0 && size >= 64, `size ${size} is not a power of two`);

  const COLORS = { a: [200, 10, 10, 255], b: [10, 200, 10, 255], c: [10, 10, 200, 128], d: [250, 250, 10, 255] };
  const seen = [];
  for (const c of cells) {
    assert.ok(c.x >= 1 && c.y >= 1, 'gutter leaves room at the atlas edge');
    assert.ok(c.x + c.w + 1 <= size && c.y + c.h + 1 <= size, 'cell + gutter must fit');
    assert.deepEqual(px(rgba, size, c.x, c.y), COLORS[c.id], `cell ${c.id} interior colour`);
    assert.deepEqual(px(rgba, size, c.x - 1, c.y), px(rgba, size, c.x, c.y), 'left gutter clamped');
    assert.deepEqual(px(rgba, size, c.x + c.w, c.y + c.h - 1), px(rgba, size, c.x + c.w - 1, c.y + c.h - 1), 'right gutter clamped');
    seen.push(c);
  }
  assert.equal(seen.length, entries.length);
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const a = seen[i], b = seen[j];
      const overlap = a.x - 1 < b.x + b.w + 1 && b.x - 1 < a.x + a.w + 1 &&
                      a.y - 1 < b.y + b.h + 1 && b.y - 1 < a.y + a.h + 1;
      assert.ok(!overlap, `cells ${a.id}/${b.id} overlap including gutters`);
    }
  }
});

test('atlas: source rows blit top-down (cell row 0 is source row 0)', () => {
  // a vertical gradient is the only shape that tells a blitted cell from a vertically mirrored one,
  // and the whole renderer assumes row 0 of a texture is its top row
  const w = 8, h = 8;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 20 + y * 20; rgba[o + 1] = 0; rgba[o + 2] = 255 - y * 20; rgba[o + 3] = 255;
    }
  }
  const { size, cells, rgba: packed } = packTextures([{ id: 'grad', w, h, rgba }], { minSize: 32 });
  const c = cells[0];
  for (let y = 0; y < h; y++) {
    assert.deepEqual(px(packed, size, c.x, c.y + y), [20 + y * 20, 0, 255 - y * 20, 255], `cell row ${y}`);
  }
  assert.deepEqual(px(packed, size, c.x, c.y - 1), [20, 0, 255, 255], 'gutter above the cell clamps to the top row');
  assert.deepEqual(px(packed, size, c.x, c.y + h), [160, 0, 115, 255], 'gutter below clamps to the bottom row');
});

test('atlas: grows past minSize when the textures do not fit', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, ...solid(16, 16, [i * 5 % 255, 30, 90, 255]) }));
  const { size, cells } = packTextures(entries, { minSize: 64 });
  assert.equal(cells.length, entries.length);
  assert.ok(size > 64, `expected growth, got ${size}`);
});

test('textureStats classifies opaque, cutout and translucent sources', () => {
  const stats = (img) => textureStats(img);
  assert.equal(stats(solid(4, 4, [1, 2, 3, 255])).transparent, 0);
  const cutout = solid(4, 4, [1, 2, 3, 255]);
  cutout.rgba[3] = 0;                                   // one fully transparent texel
  const cs = stats(cutout);
  assert.equal(cs.transparent, 1); assert.equal(cs.semi, 0);
  const semi = solid(4, 4, [1, 2, 3, 128]);
  const ss = stats(semi);
  assert.equal(ss.semi, 16); assert.equal(ss.minA, 128);
});
