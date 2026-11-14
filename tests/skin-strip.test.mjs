// The skin strip: one texture for the whole cast, with an honest answer for every player who has no skin.
//
// Why a composed strip rather than one texture per player: the people layer is ONE mesh with draw groups
// per body, so a per-player material means per-player draw calls and per-player texture binds. One strip
// keeps it to a single upload. And why the strip is composed on the server rather than in the browser: the
// browser is never allowed to talk to Mojang, so whatever the page draws has to come from here.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodePng, encodePngRgba } from '../server/png.mjs';
import { SKIN_CELL, readSkinPack, skinStripFor, stripJson, stripPng } from '../server/skin-strip.mjs';

// A 64x64 skin where each 8x8 pixel block is a solid colour, so a test can ask "which texel landed where".
function fakeSkin(seed) {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const cell = ((x >> 3) * 8 + (y >> 3)) % 64;
      rgba[i] = (cell * 4 + seed) & 255;
      rgba[i + 1] = (cell * 9 + seed * 3) & 255;
      rgba[i + 2] = (x * 3 + y * 5) & 255;
      rgba[i + 3] = 255;
    }
  }
  return encodePngRgba(64, 64, rgba);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skins-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
fs.writeFileSync(path.join(dir, 'textures', 'a.png'), fakeSkin(1));
fs.writeFileSync(path.join(dir, 'textures', 'b.png'), fakeSkin(200));
// a 64x32 skin (the old layout: no second layer) and a size that is neither
fs.writeFileSync(path.join(dir, 'textures', 'half.png'),
  encodePngRgba(64, 32, new Uint8Array(64 * 32 * 4).fill(9)));
fs.writeFileSync(path.join(dir, 'textures', 'odd.png'),
  encodePngRgba(50, 50, new Uint8Array(50 * 50 * 4).fill(3)));

const MANIFEST = {
  generated: '2026-11-14T00:00:00.000Z', world: 'DarkRPG/world', source: 'test',
  skins: [
    { name: 'Ada', uuid: 'u-ada', slim: true, texture: 'textures/a.png' },
    { name: 'Bo', uuid: 'u-bo', slim: false, texture: 'textures/b.png' },
    { name: 'Half', uuid: 'u-half', slim: false, texture: 'textures/half.png' },
    { name: 'Odd', uuid: 'u-odd', slim: false, texture: 'textures/odd.png' },
    { name: 'Gone', uuid: 'u-gone', slim: false, texture: 'textures/gone.png' },
    { name: 'Noprof', uuid: null, noProfile: true },
  ],
};
const writeManifest = (m) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
writeManifest(MANIFEST);

test('the pack reads with one column per player, and the last column belongs to nobody', () => {
  const { pack, strip } = skinStripFor(dir);
  assert.ok(pack, 'the pack should be readable');
  assert.equal(strip.cell || SKIN_CELL, SKIN_CELL);
  // One column per player the pack KNOWS ABOUT (a name with no profile is still a person the ledger has),
  // plus the white fallback column. Players whose PNG is missing or wrong-sized drop out of the strip and
  // into `missing` - they get the white column too, by the page's own rule, not a guessed face.
  assert.equal(strip.columns, pack.list.length + 1);
  assert.equal(strip.white, pack.list.length);
  assert.equal(strip.w, strip.columns * SKIN_CELL);
  assert.equal(strip.h, SKIN_CELL);
});

test('a missing or unusable skin is reported by name with a reason, never guessed at', () => {
  const { pack } = readSkinPack(dir);
  const why = Object.fromEntries(pack.missing.map((m) => [m.name, m.why]));
  assert.match(why.Gone, /not on disk/);
  assert.match(why.Odd, /50x50/);
  // A 64x32 skin IS usable: it is the old layout, and the model's UV table reuses the right-limb
  // rectangles for the left limbs when there is no second half to read.
  assert.ok(!('Half' in why), 'a 64x32 skin is a real skin, not a defect');
  // A name with no Mojang profile is reported as a fact about the log, in the same list, with its own
  // reason: the tool looked and Mojang said no. It is not silently dropped, and it is not a fetch failure.
  const np = pack.missing.find((m) => m.name === 'Noprof');
  assert.ok(np && /no Mojang profile/.test(np.why), JSON.stringify(pack.missing));
});

test('pixels land in the cell they were promised, and the fallback cell is white', () => {
  const { strip } = skinStripFor(dir);
  const { w, h, rgba } = strip;
  const px = (x, y) => {
    const i = (y * w + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
  };
  // Same texel of two different cells must differ: the two fake skins have different seeds.
  assert.notDeepEqual(px(3, 3), px(SKIN_CELL + 3, 3));
  // And cell 0 must equal the source PNG's texel exactly - no flip, no bleed into the next cell.
  const src = decodePng(fs.readFileSync(path.join(dir, 'textures', 'a.png')));
  for (const [x, y] of [[0, 0], [7, 9], [63, 63], [40, 16]]) {
    const si = (y * src.w + x) * 4;
    assert.deepEqual(px(x, y), [src.rgba[si], src.rgba[si + 1], src.rgba[si + 2], src.rgba[si + 3]],
      `texel ${x},${y} of cell 0`);
  }
  // The fallback column: opaque white everywhere, so a body's vertex colour is the whole answer there.
  for (const [x, y] of [[0, 0], [31, 33], [63, 63]]) {
    assert.deepEqual(px(strip.white * SKIN_CELL + x, y), [255, 255, 255, 255], `white cell ${x},${y}`);
  }
  assert.equal(h, SKIN_CELL);
});

test('the PNG re-encodes to the same pixels the page will upload', () => {
  const { strip } = skinStripFor(dir);
  const again = decodePng(stripPng(strip));
  assert.equal(again.w, strip.w);
  assert.equal(again.h, strip.h);
  let diff = 0;
  for (let i = 0; i < again.rgba.length; i++) if (again.rgba[i] !== strip.rgba[i]) diff++;
  assert.equal(diff, 0, 'the round trip must be lossless: this is a pixel grid, not a photograph');
});

test('the description the page reads names every column, and which one is the fallback', () => {
  const { strip, pack } = skinStripFor(dir);
  const j = stripJson(strip, pack);
  assert.equal(j.cell, SKIN_CELL);
  assert.equal(j.columns, strip.columns);
  assert.equal(j.white, strip.columns - 1);
  assert.deepEqual(j.cells.map((c) => c.column), [...Array(strip.columns).keys()]);
  assert.equal(j.cells[j.white].white, true);
  // Slim is a fact about the MODEL (3px arms, not 4), so it travels with the column rather than being
  // re-derived from the pixels.
  assert.equal(j.cells[0].slim, true);
  assert.equal(j.cells[1].slim, false);
  assert.ok(j.missing.length >= 2, 'the description carries who has no skin, and why');
});

test('no pack is an answer, not a crash: the people keep their band colours', () => {
  const r = skinStripFor(path.join(dir, 'nothing-here'));
  assert.equal(r.pack, null);
  assert.match(r.why, /manifest\.json/);
  assert.equal(readSkinPack('none').pack, null);       // --skins none / WD_SKINS=none
});

test('a manifest that changed under a running server is picked up', () => {
  // 6 entries in the manifest, but only the ones with a usable PNG reach the strip: Odd (wrong size),
  // Gone (absent) and Noprof (no profile) are in `missing` instead.
  assert.equal(skinStripFor(dir).pack.list.length, 3);
  writeManifest({ ...MANIFEST, skins: MANIFEST.skins.slice(0, 2) });
  const b = skinStripFor(dir);
  assert.equal(b.pack.list.length, 2);
  assert.equal(b.strip.columns, 3);                    // two players + white
  writeManifest(MANIFEST);
});
