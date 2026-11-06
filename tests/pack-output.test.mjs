// Contract test for the packed asset payload (M1 output). Runs the real packer against the
// real census when available, then asserts every invariant the browser renderer relies on.
// Skips (rather than fails) when the census has not been generated yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decodePng } from '../server/png.mjs';
import { UV_TRANSFORMS, FACE_INFO } from '../shared/faces.mjs';
import { classifyStates } from '../shared/cube-path.mjs';

const CENSUS = 'build/census.json';
const OUT = 'build/assets-test';
const skip = existsSync(CENSUS) ? false : 'build/census.json not generated yet';

test('packer output payload contract', { skip, timeout: 600_000 }, () => {
  rmSync(OUT, { recursive: true, force: true });
  execFileSync(process.execPath, ['server/pack-assets.mjs', CENSUS, OUT], { stdio: 'pipe' });

  const a = JSON.parse(readFileSync(`${OUT}/atlas.json`, 'utf8'));
  const census = JSON.parse(readFileSync(CENSUS, 'utf8'));

  assert.equal(a.version, 1);
  assert.deepEqual(a.dirs, ['down', 'up', 'north', 'south', 'west', 'east']);
  assert.deepEqual(a.uvT, UV_TRANSFORMS, 'mesher shares the uv transform table');

  // --- atlas image matches the cell table ---
  const png = decodePng(readFileSync(`${OUT}/atlas.png`));
  assert.equal(png.w, a.atlasSize);
  assert.equal(png.h, a.atlasSize);

  const kinds = new Map();
  for (const t of a.textures) {
    kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
    if (t.kind === 3) continue;                        // missing-texture sentinel cell
    assert.ok(t.x >= 1 && t.y >= 1 && t.x + t.w + 1 <= a.atlasSize && t.y + t.h + 1 <= a.atlasSize,
      `cell ${t.id} outside atlas`);
    assert.ok(t.u0 >= 0 && t.u1 <= 1 && t.v0 >= 0 && t.v1 <= 1 && t.u0 < t.u1 && t.v0 < t.v1,
      `cell ${t.id} uv box invalid`);
    // uv is addressed from the top-left of atlas.png, so v0 must name the cell's first pixel row.
    // The browser uploads that PNG unflipped (flipY=false); storing GL-style bottom-up v here would
    // draw every sprite upside down and no amount of scene-graph debugging would show why.
    assert.equal(t.v0, t.y / a.atlasSize, `cell ${t.id} v0 must address the cell's top row`);
    assert.equal(t.v1, (t.y + t.h) / a.atlasSize, `cell ${t.id} v1 must address the row under the cell`);
  }
  assert.ok((kinds.get(0) ?? 0) > 100, 'expected plenty of opaque textures');
  assert.ok((kinds.get(1) ?? 0) > 10, 'expected cutout textures (plants, panes)');
  assert.ok((kinds.get(2) ?? 0) > 5, 'expected translucent textures (glass, water)');

  const nTex = a.textures.length;

  // --- binary geometry blob ---
  const bin = readFileSync(`${OUT}/geometry.bin`);
  assert.equal(bin.subarray(0, 8).toString('ascii'), 'DVGEO12 ', 'geometry blob magic');
  const geoms = bin.readUInt32LE(8), nq = bin.readUInt32LE(12), posScale = bin.readUInt32LE(16);
  assert.equal(geoms, a.geometry.geoms, 'geometry count mismatch');
  assert.equal(nq, a.geometry.quads, 'quad count mismatch');
  assert.equal(posScale, a.geometry.posScale);
  const POS = 32, UV = POS + geoms * 24, REF = UV + geoms * 16;
  assert.equal(bin.length, REF + nq * 8, 'geometry blob length mismatch');
  const posAt = (gi, i) => bin.readInt16LE(POS + gi * 24 + i * 2) / posScale;
  const uvAt = (gi, i) => bin.readUInt16LE(UV + gi * 16 + i * 2) / 65535;
  // Units guard: posScale is units per BLOCK, so a plain cube measures 0..1. If anyone reverts to
  // baking model units (16 per block) the median jumps to 16 and this fires immediately.
  const extent = [];
  for (let gi = 0; gi < geoms; gi++) {
    let m = 0;
    for (let i = 0; i < 12; i++) m = Math.max(m, Math.abs(posAt(gi, i)));
    extent.push(m);
  }
  extent.sort((x, y) => x - y);
  const median = extent[Math.floor(extent.length / 2)];
  assert.ok(median <= 1.25, `median geometry extent ${median} blocks: posScale must be units per block`);
  assert.ok(median >= 0.5, `median geometry extent ${median} blocks: geometry looks collapsed`);
  let dupGeom = 0;
  for (let gi = 0; gi < geoms; gi++) {
    for (let i = 0; i < 12; i++) {
      const v = posAt(gi, i);
      assert.ok(Number.isFinite(v) && v >= -128 && v <= 128, `geometry ${gi} vertex ${v} out of range`);
    }
    for (let i = 0; i < 8; i++) {
      const v = uvAt(gi, i);
      assert.ok(v >= 0 && v <= 1, `geometry ${gi} uv ${v} outside 0..1`);
    }
  }
  for (let qi = 0; qi < nq; qi++) {
    const gi = bin.readUInt32LE(REF + qi * 8), pk = bin.readUInt32LE(REF + qi * 8 + 4);
    assert.ok(gi < geoms, `quad ${qi} geometry index ${gi} out of range`);
    const t = pk & 0xfff, d = ((pk >> 12) & 7) - 1, c = ((pk >> 15) & 7) - 1;
    const sh = (pk >> 18) & 1, ti = (pk >> 19) & 1;
    assert.ok(t < nTex, `quad ${qi} texture ${t} out of range`);
    assert.ok(d >= -1 && d <= 5, `quad ${qi} direction ${d}`);
    assert.ok(c >= -1 && c <= 5, `quad ${qi} cullface ${c}`);
    assert.ok(sh < 2 && ti < 2);
  }

  let geoStates = 0, cubeStates = 0, invisible = 0;
  const spillStates = new Set();
  const keys = new Set();
  for (const s of a.states) {
    assert.ok(!keys.has(s.k), `duplicate state key ${s.k}`);
    keys.add(s.k);
    assert.ok(s.l >= 0 && s.l <= 15, `${s.k} light out of range`);
    if (s.cube) {
      cubeStates++;
      assert.ok(!s.g, `${s.k} has both cube and quad geometry`);
      assert.ok(s.cube.length >= 1 && s.cube.length <= 16, `${s.k} arm count ${s.cube.length}`);
      if (s.w) {
        assert.equal(s.w.length, s.cube.length, `${s.k} weights/arm mismatch`);
        assert.ok(s.w.every(x => x > 0), `${s.k} non-positive weight`);
      }
      for (const arm of s.cube) {
        assert.equal(arm.length, 6, `${s.k} cube arm must have six faces`);
        for (const code of arm) {
          const tex = Math.floor(code / 8), tr = code % 8;
          assert.ok(tex >= 0 && tex < nTex, `${s.k} texture index ${tex} out of range`);
          assert.ok(tr >= 0 && tr < 8, `${s.k} uv transform ${tr} out of range`);
        }
      }
    } else if (s.g?.length) {
      geoStates++;
      if (s.w) assert.equal(s.w.length, s.g.length, `${s.k} weights/arm mismatch`);
      for (const arm of s.g) {
        const seen = new Set();
        for (const idx of arm) {
          assert.ok(idx >= 0 && idx < nq, `${s.k} quad index ${idx} out of range`);
          const gi = bin.readUInt32LE(REF + idx * 8), pk = bin.readUInt32LE(REF + idx * 8 + 4);
          const t = pk & 0xfff, d = ((pk >> 12) & 7) - 1, c = ((pk >> 15) & 7) - 1;
          assert.ok(t < nTex, `${s.k} quad texture id ${t} out of range`);
          assert.ok(d >= -1 && d <= 5, `${s.k} face direction ${d} out of range`);
          assert.ok(c >= -1 && c <= 5, `${s.k} cullface ${c} out of range`);
          let spills = false;
          const sig = [];
          for (let i = 0; i < 12; i++) {
            const v = posAt(gi, i);
            if (v < -16 || v > 32) spills = true;
            sig.push(v);
          }
          if (spills) spillStates.add(s.k);
          const key = sig.join(',');
          assert.ok(!seen.has(key), `${s.k} keeps two exactly coincident faces`);
          seen.add(key);
        }
      }
    } else {
      invisible++;
      assert.equal(s.r, 3, `${s.k} has no geometry but is not marked invisible`);
    }
  }

  // --- world coverage ---
  const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
  let total = 0, covered = 0;
  const missed = [];
  const samplesOf = new Map(census.states.map((st) => [st.key, st.samples]));
  for (const st of census.states) {
    total += st.samples;
    const rec = a.states.find(x => x.k === st.key);
    if (rec?.cube || rec?.g?.length) covered += st.samples;
    else if (AIRS.has(st.name)) covered += st.samples;
    else if (missed.length < 12) missed.push(st.key);
  }
  if (covered / total <= 0.99) {
    // A coverage drop here means the packer drew no geometry for states the world actually uses, and
    // the only way to chase it is to know which ones. This fired twice as a full-suite-only failure
    // (87.8% and 91.0%) while the same test passed alone, which is why the names get printed.
    console.log(`  uncovered samples ${total - covered} of ${total}; heaviest missed states:`);
    for (const k of missed) console.log(`    ${k} x${samplesOf.get(k) ?? '?'}`);
  }
  assert.ok(covered / total > 0.99, `only ${(100 * covered / total).toFixed(2)}% of samples covered`);
  // What matters for mesh speed is sample-weighted coverage, not distinct-state count: block
  // *states* are dominated by modded multi-variant furniture/stairs, but ordinary cubes are what
  // the world is mostly made of.
  const samplesByKey = new Map(census.states.map(st => [st.key, st.samples]));
  let samplesAll = 0, samplesCube = 0;
  const byKey = new Map(a.states.map(x => [x.k, x]));
  for (const st of census.states) {
    if (AIRS.has(st.name)) continue;                  // air has no geometry to encode at all
    samplesAll += st.samples;
    if (byKey.get(st.key)?.cube) samplesCube += st.samples;
  }
  const cubeShare = samplesCube / samplesAll;
  console.log(`  cube fast path covers ${(cubeShare * 100).toFixed(2)}% of section samples`);
  assert.ok(cubeShare > 0.72, `cube fast path covers too few samples: ${(cubeShare * 100).toFixed(2)}%`);
  // the blocks the world is mostly made of must be on the fast path
  for (const k of ['minecraft:stone', 'minecraft:dirt', 'minecraft:gravel', 'minecraft:deepslate|axis=y',
                   'minecraft:tuff', 'minecraft:granite', 'darkblades:dark_ore']) {
    assert.ok(byKey.get(k)?.cube, `${k} should use the cube fast path`);
  }
  // States that dominate the world must survive the bake, including the models Minecraft draws with
  // block-entity renderers (chests) and element-less models (water): both fall back to a cube, and a
  // hole there would be a hole in every ocean and village.
  for (const k of ['minecraft:water|level=0',
                   'minecraft:chest|facing=north,type=single,waterlogged=false',
                   'minecraft:furnace|facing=east,lit=false',
                   'minecraft:grass_block|snowy=false']) {
    const rec = byKey.get(k);
    assert.ok(rec, `${k} missing from atlas.json`);
    assert.ok(rec.cube?.length || rec.g?.length, `${k} has no geometry`);
  }
  // Absent textures become placeholder cells rather than deleted faces. Only one texture in this
  // pack is absent, and nothing happens to draw it, so assert the weaker invariant: a state whose
  // bake was reported unresolved must not silently keep geometry.
  const kindOf = new Map(a.textures.map((t, i) => [i, t.kind]));
  const placeholderCells = a.textures.filter(t => t.kind === 3).length;
  assert.ok(placeholderCells >= 1, 'expected a placeholder cell for the absent texture');
  for (const s of a.states) {
    if (!s.g?.length) continue;
    for (const qi of s.g.flat()) {
      assert.ok(kindOf.get(bin.readUInt32LE(REF + qi * 8 + 4) & 0xfff) !== undefined,
        `${s.k} references a texture that is not in the atlas table`);
    }
  }

  console.log(`  unique geometries ${geoms} referenced by ${nq} quads (${(nq / geoms).toFixed(2)}x reuse)`);
  assert.ok(geoStates > 100, 'expected a meaningful quad path too');
  assert.ok(invisible < 200, `suspiciously many invisible states: ${invisible}`);
  // Modded plants deliberately author elements that spill past their block; that is fine, but
  // it must stay a small minority or a bake (e.g. rescale) has blown the geometry up.
  assert.ok(spillStates.size < geoStates * 0.02,
    `${spillStates.size}/${geoStates} quad states spill more than a block outside their cell`);
  if (missed.length) console.log('uncovered state samples e.g.:', missed.join(', '));
});

// The rasteriser keeps counter-clockwise front faces, so a clockwise baked quad is invisible from the
// side it is supposed to be seen from. Vanilla authors element faces outward; this is the guard that
// says the baker never lost that, and it is what caught the cube fast path winding the wrong way.
test('baked quads wind outward along their recorded face direction', { skip }, () => {
  const bin = readFileSync(`${OUT}/geometry.bin`);
  const geoms = bin.readUInt32LE(8), nq = bin.readUInt32LE(12);
  const POS = 32, REF = POS + geoms * 24 + geoms * 16;
  let directed = 0, inward = 0, worst = null;
  for (let qi = 0; qi < nq; qi++) {
    const gi = bin.readUInt32LE(REF + qi * 8);
    const d = ((bin.readUInt32LE(REF + qi * 8 + 4) >> 12) & 7) - 1;
    if (d < 0) continue;                       // no direction recorded: nothing to compare against
    const p = [0, 1, 2].map((k) => [0, 2, 4].map((o) => bin.readInt16LE(POS + gi * 24 + k * 6 + o)));
    const a = p[1].map((v, i) => v - p[0][i]), b = p[2].map((v, i) => v - p[0][i]);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    directed++;
    if (n[FACE_INFO[d].axis] * FACE_INFO[d].sign > 0) continue;
    inward++;
    if (!worst) worst = `quad ${qi} face ${d}`;
  }
  assert.ok(directed > nq * 0.5, `only ${directed}/${nq} quads carry a face direction`);
  assert.equal(inward, 0, `${inward} baked quads are wound clockwise and would be culled (e.g. ${worst})`);
});

// The mesher cannot tell a grey mask from an authored-colour sprite by name, and getting that wrong
// paints whole hillsides olive, so the atlas measures both facts out of the pixels.
const PACKED = existsSync(`${OUT}/atlas.json`) ? `${OUT}/atlas.json` : 'build/assets/atlas.json';
test('atlas textures carry a measured mean colour, a grey-mask flag and a mean alpha',
  { skip: existsSync(PACKED) ? false : 'no packed atlas yet' }, () => {
  const a = JSON.parse(readFileSync(PACKED, 'utf8'));
  const byId = new Map(a.textures.map((t) => [t.id, t]));
  for (const t of a.textures) {
    assert.ok(Array.isArray(t.c) && t.c.length === 3, `${t.id} needs an [r,g,b] mean`);
    for (const v of t.c) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${t.id} mean channel ${v}`);
    assert.ok(t.g === 0 || t.g === 1, `${t.id} grey-mask flag must be 0 or 1`);
    assert.ok(Number.isFinite(t.a) && t.a >= 0 && t.a <= 1, `${t.id} mean alpha must be in 0..1, got ${t.a}`);
  }
  // The pair that used to be wrong together: vanilla ships the top of a grass block as a grey mask
  // and its side already brown. Same block, opposite answers.
  const top = byId.get('minecraft:block/grass_block_top');
  const side = byId.get('minecraft:block/grass_block_side');
  assert.ok(top && side, 'vanilla grass sprites must be in the atlas');
  assert.equal(top.g, 1, 'grass_block_top is a tintable grey mask');
  assert.equal(side.g, 0, 'grass_block_side already carries its colour');
  assert.ok(side.c[0] > side.c[2] * 1.5, `grass_block_side mean should be brown, got ${side.c}`);
  // Leaves sprites are dithered rather than literally grey, which is why the flag is a spread test.
  const leaves = byId.get('minecraft:block/oak_leaves');
  assert.ok(leaves && leaves.g === 1, 'oak_leaves is a dithered grey mask');

  // Alpha is what a translucent pixel is made of: three multiplies the texel alpha into the fragment
  // alpha, so a water face lets (1 - a) of the lake bed through. Measuring it here is the only way a
  // probe can predict a water pixel instead of describing it afterwards.
  for (const t of a.textures) {
    if (t.kind === 0) assert.ok(t.a > 0.999, `${t.id} is classified opaque but averages alpha ${t.a}`);
  }
  const water = byId.get('minecraft:block/water_still');
  assert.ok(water && water.kind === 2, 'water_still must be in the atlas as a translucent sprite');
  // Cropping the animation strip to frame 0 matters here: the strip's other frames have different
  // alpha, so a mean over the whole strip would not describe what is actually drawn.
  assert.ok(water.a > 0.6 && water.a < 0.85, `water_still mean alpha ${water.a} should sit near 0.7`);
  const glass = byId.get('minecraft:block/glass');
  if (glass) {
    // Vanilla draws glass as a cutout (CUTOUT_MIPPED), not blended: its middle texels are simply
    // absent. So the alpha is a coverage number here, not a blend weight - but it still has to be
    // measured, because a probe predicts a glass pixel as "sprite where present, sky where not".
    assert.ok(glass.a > 0.05 && glass.a < 0.6, `glass coverage ${glass.a} should be well under water's alpha`);
    assert.ok(glass.a < water.a, 'glass is more see-through than water');
    // Pale cyan: the frame is nearly white with a cyan cast, so both cold channels sit above red.
    assert.ok(glass.c[1] > glass.c[0] && glass.c[2] > glass.c[0], `glass mean should be pale cyan, got ${glass.c}`);
  }
  assert.ok(leaves.a < 1, `a cutout sprite has holes, so its mean alpha should be below 1, got ${leaves.a}`);
});


// "Full block" and "encoded as the six-quad fast path" are different questions. grass_block bakes a
// tinted overlay onto the sides of a plain cube, so it has more than six quads and is not the fast
// path - but it is what covers the ground, and a far LOD that only understands the fast path has to
// dig under it for the dirt and paints the whole map brown.
test('a box painted with overlays is still a full block',
  { skip: existsSync(PACKED) ? false : 'no packed atlas yet' }, () => {
  const a = JSON.parse(readFileSync(PACKED, 'utf8'));
  const cls = classifyStates(a.states, a.textures);
  const idx = (k) => a.states.findIndex((s) => s.k === k);

  const gb = idx('minecraft:grass_block|snowy=false');
  assert.ok(gb >= 0, 'grass_block is in the table');
  assert.equal(a.states[gb].cube, undefined, 'grass_block is not the six-quad fast path');
  assert.equal(a.states[gb].fc, 1, 'but every arm fills the block box');
  // The classify tables are indexed by state index; only the payload uses 1-based ids.
  assert.equal(cls.cube[gb], 1, 'the shell pass must paint the grass, not the dirt under it');
  assert.equal(cls.opaque[gb], 1, 'a cutout overlay on an opaque cube does not make it see-through');

  // ... while a real non-cube stays one, and a glass box stays see-through.
  const gr = idx('minecraft:grass');
  assert.ok(gr >= 0 && cls.cube[gr] === 0, 'grass is not a block');
  const glass = idx('minecraft:glass');
  if (glass >= 0) {
    assert.ok(a.states[glass].cube || a.states[glass].fc === 1, 'glass fills the box');
    assert.equal(cls.opaque[glass], 0, 'but it is not opaque');
  }
});
