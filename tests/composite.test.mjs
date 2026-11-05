// The arithmetic behind every translucent pixel. A water face is a blend of the sprite over whatever
// is under it, and both factors in that blend are measured facts about the world: the material opacity
// we chose, and the alpha baked into the sprite. Pinning the algebra here is what lets a framebuffer
// probe predict a lake instead of describing one after the fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { clamp01, layerAlpha, over, stackOver, dmax } from '../shared/composite.mjs';

test('source-over behaves like the fixed-function blender', () => {
  assert.deepEqual(stackOver([0, 0, 0], [{ rgb: [255, 255, 255], a: 1 }]).rgb, [255, 255, 255]);
  assert.deepEqual(stackOver([10, 20, 30], [{ rgb: [255, 255, 255], a: 0 }]).rgb, [10, 20, 30]);
  assert.deepEqual(over([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);

  // Two half-alpha layers are not one opaque layer: coverage multiplies the gaps.
  const r = stackOver([0, 0, 0], [{ rgb: [200, 100, 50], a: 0.5 }, { rgb: [200, 100, 50], a: 0.5 }]);
  assert.ok(Math.abs(r.coverage - 0.75) < 1e-9, `coverage ${r.coverage}`);
  assert.deepEqual(r.rgb, [150, 75, 38]);   // 0.75 of [200,100,50] over black
  assert.equal(r.used, 2);

  // A stack stops as soon as it is opaque, and says how many layers it consumed - a probe that
  // predicted a pixel from one layer when the ray hit four is announcing a mis-attribution.
  const stop = stackOver([9, 9, 9], [{ rgb: [200, 0, 0], a: 1 }, { rgb: [0, 200, 0], a: 1 }]);
  assert.deepEqual(stop.rgb, [200, 0, 0]);
  assert.equal(stop.used, 1);
  assert.equal(stop.coverage, 1);
});

test('a translucent layer weighs material opacity times its own sprite alpha', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(layerAlpha(1, undefined), 1);
  assert.equal(layerAlpha(0.72, 1), 0.72);
  // Water on this server: material opacity 0.72, water_still frame 0 averages 0.706 alpha. Using the
  // material value alone makes every predicted water pixel too saturated, because it hides nearly half
  // the lake bed that the framebuffer plainly shows.
  assert.ok(Math.abs(layerAlpha(0.72, 0.706) - 0.508) < 1e-3);
  assert.ok(layerAlpha(0.72, 0.706) < 0.72, 'the sprite can only make a layer more see-through');
});

const ATLAS = 'build/assets/atlas.json';
test('the atlas reports the alpha that the blender will use', { skip: existsSync(ATLAS) ? false : 'no baked atlas yet' }, () => {
  const a = JSON.parse(readFileSync(ATLAS, 'utf8'));
  const byId = new Map(a.textures.map((t) => [t.id, t]));

  // An opaque sprite must average full alpha, or the pass it is drawn in is a lie.
  for (const t of a.textures) {
    assert.ok(Number.isFinite(t.a) && t.a >= 0 && t.a <= 1, `${t.id} alpha ${t.a}`);
    if (t.kind === 0) assert.ok(t.a > 0.999, `${t.id} is classified opaque but averages alpha ${t.a}`);
  }

  const water = byId.get('minecraft:block/water_still');
  assert.ok(water && water.kind === 2, 'water_still must be packed translucent');
  assert.ok(water.a > 0.6 && water.a < 0.85, `water_still alpha ${water.a}`);

  // The measured case the whole investigation rests on: water over dirt, both means out of the atlas,
  // lands on the framebuffer triple a probe reads at a lake surface.
  const dirt = byId.get('minecraft:block/dirt');
  assert.ok(dirt && dirt.kind === 0, 'dirt must be packed opaque');
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toSrgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  // water_still is a grey mask, so the placeholder water tint is what the mesher multiplies in
  const wcol = [0, 1, 2].map((i) => toSrgb(lin(water.c[i] / 255) * [0.3, 0.55, 0.85][i]));
  const bed = dirt.c;
  const pred = stackOver(bed, [{ rgb: wcol, a: layerAlpha(0.72, water.a) }]).rgb;
  // Probe reading at a lake surface, close enough that mip level 0 applies (build/probe_wstack.log).
  const seen = [124, 128, 124];
  const withSpriteAlpha = dmax(pred, seen);
  const withMaterialOnly = dmax(stackOver(bed, [{ rgb: wcol, a: 0.72 }]).rgb, seen);
  assert.ok(withSpriteAlpha < withMaterialOnly,
    `sprite alpha must improve the prediction: ${withSpriteAlpha} vs ${withMaterialOnly} (${pred} vs ${seen})`);
});
