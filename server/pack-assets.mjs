// M1: bake the block states that this world actually contains into geometry + one atlas.
//   node server/pack-assets.mjs [census.json] [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { AssetIndex, defaultJars } from './asset-index.mjs';
import { decodePng, encodePngRgba } from './png.mjs';
import { ModelResolver, bakeApply } from './model-resolve.mjs';
import { packTextures, textureStats } from './atlas.mjs';
import { UV_TRANSFORMS, FACE_INFO, quadNormal } from '../shared/faces.mjs';
import { cubeArmCodes, fullCubeArm, MAX_ARMS } from '../shared/cube-path.mjs';

const CENSUS = process.argv[2] ?? 'build/census.json';
const OUT = process.argv[3] ?? 'build/assets';
const SERVER_ROOT = process.env.SERVER_ROOT ?? 'DarkRPG';
const VANILLA_JAR = process.env.VANILLA_JAR ??
  'your .minecraft/versions/1.20.1/1.20.1.jar';

const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const BLEND_NAMES = /(water|lava|glass|ice|slime|honey|beacon|portal|shulker|curtain|crystal|fence|pane|leaves)/;

// Placeholder light levels; real values move to the server's block light table in M6.
const LIGHT = [
  [/(torch|lantern|glowstone|shroomlight|sea_lantern|beacon|end_rod|jack_o|candle|lamp|glow|lumen|fire|flashcrystal|crystal_ore|amber|cinnabar)/, 14],
  [/(furnace|blast_furnace|smoker)/, 13],
  [/(lava|molten)/, 15],
  [/(redstone_torch|redstone_lamp)/, 13],
];
const guessLight = (name) => {
  if (AIRS.has(name)) return 0;
  for (const [re, v] of LIGHT) if (re.test(name)) return v;
  return 0;
};

// Vanilla models mostly do not carry tintindex for biome-tinted blocks (grass/leaves use a
// colormap instead), so flag them by name; M6 replaces this with a real tint table.
const TINT_NAMES = /(water|grass|leaves|foliage|fern|vine|sapling|shrub|canopy|sprout|kelp|seagrass|lily|azalea|mycelium|podzol|coarse_dirt|_crop|carrots|potatoes|beetroots|melon|bamboo|cactus|spore|blossom|leaf|tree_fern|pasturable)/;

const census = JSON.parse(fs.readFileSync(CENSUS, 'utf8'));
const index = new AssetIndex(defaultJars(SERVER_ROOT, VANILLA_JAR));
const resolver = new ModelResolver(index);
console.log(`asset index: ${JSON.stringify(index.stats)}`);

// ---- textures: decoded lazily, deduped, stats for material classification ----
const texIds = new Map();  // texture id -> index
const texList = [];        // { id, img, stats, animated }
/**
 * Vanilla animation strips are one texture `w x (w*n)` with the frames stacked vertically
 * (water_still is 16 x 512). Packing the whole strip squeezes 32 frames into a 2 x 64 cell and
 * the block renders as shimmering stripes, so keep frame 0 and remember that it animates.
 */
function firstFrame(img) {
  if (img.h <= img.w || img.h % img.w !== 0) return img;
  const w = img.w, h = img.w, rgba = new Uint8Array(w * h * 4);
  rgba.set(img.rgba.subarray(0, w * h * 4));
  return { w, h, rgba, frames: img.h / img.w };
}

function texIndexFor(id) {
  if (!id.includes(':')) id = 'minecraft:' + id;   // bare refs in model json are minecraft-namespaced
  let i = texIds.get(id);
  if (i !== undefined) return i;
  const bytes = index.readPng(id);
  i = texList.length;
  texIds.set(id, i);
  if (bytes) {
    try {
      const img = firstFrame(decodePng(bytes));
      texList.push({
        id, img, stats: textureStats(img),
        animated: (img.frames ?? 1) > 1 || bytes.includes(Buffer.from('acTL')),
      });
    } catch (e) { texList.push({ id, img: null, stats: null, animated: false, error: String(e.message) }); }
  } else {
    texList.push({ id, img: null, stats: null, animated: false, missing: true });
    resolver.miss(`textures/${id}.png`);
  }
  return i;
}

// ---- bake every state present in the world ----
// Geometry is stored once per unique (positions, sprite-uv) pair and referenced per quad: weighted
// variants are the same shape wearing different textures, so only the reference differs.
const bakeStats = { uvClamped: 0 };
// Geometry is quantised: positions in 1/256 of a block (range +-128 blocks), sprite uv in 1/65535.
const POS_SCALE = 4096;         // quantisation units per BLOCK; 1/256 block ~= 4 mm at 1 m blocks
const MODEL_UNITS = 16;         // baked model space is 16 units per block
const POS_NUDGE = 4;      // coplanar duplicate separation, in 1/256 blocks
const geomPos = [];     // 12 model-space positions per unique geometry
const geomUv = [];      // 8 uv per unique geometry, 0..1 inside its own sprite
const geomIndex = new Map();
const quadRefs = [];    // [geometry index, packed(tex, cull+1, shade, tint)] per quad
const states = [];
const seenKeys = new Set();
let unresolved = 0, invisible = 0, cubesFast = 0, builtinModel = 0;

for (const st of census.states) {
  const key = st.key;
  if (seenKeys.has(key)) continue;
  seenKeys.add(key);
  if (AIRS.has(st.name)) { states.push({ k: key, r: 3, g: [], l: 0 }); continue; }

  const applies = resolver.applies(st.name, st.props);
  if (!applies) { unresolved++; states.push({ k: key, r: 3, g: [], l: 0, u: 1 }); continue; }
  // Chests, signs, banners ... are drawn by block-entity renderers in Minecraft: their model is
  // "builtin/entity" and carries only a particle texture. We bake a plain cube for those, which is
  // honest about the block but not its real shape, so keep a count for the report.
  let usedFallback = false;

  // multipart merges every matching part into one arm; weighted/random variants become arms
  const multipart = !!resolver.blockstate(st.name)?.multipart;
  const bakedArms = multipart ? [{ quads: [], weight: 1 }] : [];
  for (const a of applies) {
    if (!multipart) bakedArms.push({ quads: [], weight: Number(a.weight) || 1 });
    const gi = multipart ? 0 : bakedArms.length - 1;
    const baked = bakeApply(resolver, a.model, a, (id) => {
      const t = texIndexFor(id);
      return texList[t].img ? t : -1;
    });
    if (baked) { if (baked.kind === 'cube-fallback') usedFallback = true; bakedArms[gi].quads.push(...baked.quads); }
  }
  const realArms = bakedArms.filter(a => a.quads.length);
  if (usedFallback) builtinModel++;
  if (!realArms.length) { invisible++; states.push({ k: key, r: 3, g: [], l: 0 }); continue; }

  // Drop arms that are byte-identical after baking, folding their weights together (vanilla
  // "mirrored" variants of a plain cube mostly collapse here).
  const uniq = [];
  const sigs = new Map();
  for (const a of realArms) {
    const sig = a.quads.map(q => `${q.p.join(',')}|${q.u.join(',')}|${q.t}`).join(';');
    const at = sigs.get(sig);
    if (at !== undefined) { uniq[at].weight += a.weight; continue; }
    sigs.set(sig, uniq.length);
    uniq.push({ quads: a.quads, weight: a.weight });
  }
  // Bound the payload: overflow arms merge into the last one, keeping total weight exact.
  if (uniq.length > MAX_ARMS) {
    const keep = uniq.slice(0, MAX_ARMS - 1);
    const tail = uniq.slice(MAX_ARMS - 1);
    keep.push({ quads: tail[0].quads, weight: tail.reduce((x, a) => x + a.weight, 0) });
    uniq.length = 0; uniq.push(...keep);
  }
  const arms = uniq.map(a => a.quads);
  // A state can be a full block without matching the six-quad fast path. Vanilla grass_block paints
  // a tinted overlay on the side faces of an otherwise plain cube, so it bakes ten quads and fails
  // cubeArmCodes - but it occludes its neighbours, hides the faces under it, and is what stands on
  // top of the ground. `fc` records the shape fact separately from the encoding.
  const solidBox = arms.every(fullCubeArm);

  // Fast path: every arm is a plain unit cube -> six face codes per arm instead of geometry.
  const cubeArms = arms.map(cubeArmCodes);
  if (cubeArms.every(c => c)) {
    const seen = new Map();
    const cube = [], w = [];
    for (let i = 0; i < cubeArms.length; i++) {
      const s = cubeArms[i].join(',');
      if (seen.has(s)) { w[seen.get(s)] += uniq[i].weight; continue; }
      seen.set(s, cube.length);
      cube.push(cubeArms[i]);
      w.push(uniq[i].weight);
    }
    const tinted = uniq.some(a => a.quads.some(q => q.i)) || TINT_NAMES.test(st.name);
    const rec = { k: key, cube, r: 0, l: guessLight(st.name), ti: tinted ? 1 : 0 };
    if (cube.length > 1) rec.w = w;
    states.push(rec);
    cubesFast++;
    continue;
  }

  const groups = [];
  const w = [];
  for (let i = 0; i < uniq.length; i++) {
    const g = [];
    const dup = new Map();
    for (const q of uniq[i].quads) {
      if (q.t >= 4096) { resolver.note(`too many packed textures to reference (${q.t})`); continue; }
      // Work in the quantised space the geometry blob uses, so "identical" for the dedupe below
      // means identical to the renderer rather than identical to 1e-9.
      const base = q.p.map(x => Math.round(x * POS_SCALE / MODEL_UNITS));
      const sig = base.join(',');
      const n = dup.get(sig) ?? 0;
      dup.set(sig, n + 1);
      // Vanilla draws some faces twice in the same plane (grass_block's tinted side overlay,
      // multipart overlaps). Coplanar duplicates z-fight in a depth-tested renderer, so push each
      // repeat POS_NUDGE along its normal - ~1.6 mm at one block per metre, invisible but depth-separating.
      const off = n * POS_NUDGE;
      const v = q.d >= 0 ? FACE_INFO[q.d].v : quadNormal(q.p);
      const posI = [];
      for (let c = 0; c < 12; c += 3) {
        posI.push(base[c] + Math.round(v[0] * off), base[c + 1] + Math.round(v[1] * off), base[c + 2] + Math.round(v[2] * off));
      }
      const uvI = [];
      for (const value of q.u) {
        if (value < -0.001 || value > 1.001) bakeStats.uvClamped++;
        uvI.push(Math.round(Math.min(1, Math.max(0, value)) * 65535));
      }
      const gsig = posI.join(',') + '|' + uvI.join(',');
      let gi = geomIndex.get(gsig);
      if (gi === undefined) {
        gi = geomPos.length / 12;
        geomIndex.set(gsig, gi);
        for (const x of posI) geomPos.push(x);
        for (const x of uvI) geomUv.push(x);
      }
      g.push(quadRefs.length / 2);
      // packed quad flags: tex 0..11, dir 12..14, cullface 15..17, shade 18, tint 19
      // (dir/cullface are stored +1 so that -1, "not axis aligned"/"no cullface", fits)
      quadRefs.push(gi, q.t | ((q.d + 1) << 12) | ((q.c + 1) << 15) | (q.s << 18) | (q.i << 19));
    }
    groups.push(g);
    w.push(uniq[i].weight);
  }
  const rec = {
    k: key,
    g: groups,
    r: 0,
    l: guessLight(st.name),
    ti: uniq.some(a => a.quads.some(q => q.i) || TINT_NAMES.test(st.name)) ? 1 : 0,
  };
  if (solidBox) rec.fc = 1;
  if (uniq.length > 1) rec.w = w;
  states.push(rec);
}

// ---- pack textures ----
// A texture that is absent or undecodable still gets a real atlas cell, painted with the magenta
// checker Minecraft uses for missing textures: geometry stays visible and the gap is obvious
// instead of silently turning blocks into air.
function missingSprite() {
  const S = 16, rgba = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dark = (((x >> 2) ^ (y >> 2)) & 1) === 0;
    const i = (y * S + x) * 4;
    rgba[i] = dark ? 200 : 60; rgba[i + 1] = 0; rgba[i + 2] = dark ? 200 : 60; rgba[i + 3] = 255;
  }
  return { w: S, h: S, rgba };
}
const MISSING = missingSprite();
const packed = packTextures(
  texList.map(t => {
    const img = t.img ?? MISSING;
    return { id: t.id, w: img.w, h: img.h, rgba: img.rgba, stats: t.stats ?? textureStats(img), animated: t.animated };
  }),
  { maxSide: 64, minSize: 256 },
);
const cellById = new Map(packed.cells.map(c => [c.id, c]));
const AS = packed.size;
const unpacked = [];

/**
 * Two facts about a sprite, measured from its own pixels, that the mesher cannot guess:
 *
 *  - `c`, the mean of its visible texels. The far LOD paints a whole column with this; a column is a
 *    couple of pixels wide there, so the mean is exactly what those pixels would average to, and it
 *    does not shatter into mip noise. Averaging only texels the sprite actually draws keeps a mostly
 *    transparent leaves sprite from averaging to black.
 *  - `g`, whether the sprite is a greyscale *mask* rather than a coloured texture. Vanilla ships
 *    `grass_block_top`/`oak_leaves`/`water_still` as grey masks that the renderer is expected to tint
 *    by biome, but it ships `grass_block_side` already brown, and mods overwhelmingly author colour.
 *    Multiplying a green tint into an already coloured sprite is what turned whole hillsides olive.
 *
 * Dithered vanilla masks are not literally grey (oak_leaves averages to 144,144,144 while no two
 * channels are ever equal), so the test is per-texel channel spread, not exact equality.
 */
// Per-sprite measurements the renderer and the probes need:
//   c  mean colour over the *visible* texels (a fully transparent texel has no colour to contribute)
//   g  1 when the sprite is a grey mask, i.e. it exists to be tinted
//   a  mean alpha over *every* texel of the cell, including the transparent ones
// `a` is over all texels on purpose: the GPU multiplies the texel alpha into the fragment alpha, so
// the average weight a translucent quad really gets over its face is exactly this number. water_still
// measures 0.706, stained glass 0.46, prismarite shine 0.03 - that spread is what vanilla relies on,
// and it is the factor a colour probe has to model to explain a water pixel.
function spriteStats(img) {
  let r = 0, g = 0, b = 0, n = 0, mask = 0, alpha = 0;
  const cells = img.w * img.h;
  for (let i = 0; i < img.rgba.length; i += 4) {   // img is already frame 0 (firstFrame cropped strips)
    const a = img.rgba[i + 3];
    alpha += a;
    if (a < 16) continue;
    const R = img.rgba[i], G = img.rgba[i + 1], B = img.rgba[i + 2];
    r += R; g += G; b += B; n++;
    if (Math.max(R, G, B) - Math.min(R, G, B) <= 12) mask++;
  }
  if (!n) return { c: [136, 136, 136], g: 0, a: 0 };
  return {
    c: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    g: mask >= n * 0.85 ? 1 : 0,
    a: Math.round((alpha / Math.max(1, cells)) / 255 * 1000) / 1000,
  };
}

const textures = texList.map(e => {
  const c = cellById.get(e.id);
  if (!e.img) {
    unpacked.push({ id: e.id, reason: e.error ?? (e.missing ? 'no such png in any jar' : 'undecodable') });
    return { id: e.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 3, anim: 0, c: [200, 0, 200], g: 0, a: 1,
      u0: c.x / AS, v0: c.y / AS, u1: (c.x + c.w) / AS, v1: (c.y + c.h) / AS };
  }
  const s = c.src.stats;
  const sp = spriteStats(e.img);   // e.img is frame 0 of the sprite, before atlas packing
  let kind = 0;
  if (s.semi > 0 && (s.transparent > 0 || s.semi > s.opaque * 0.02)) kind = 2;
  else if (s.transparent > 0) kind = 1;
  return {
    id: e.id, x: c.x, y: c.y, w: c.w, h: c.h, kind,
    anim: c.src.animated ? 1 : 0,
    c: sp.c, g: sp.g, a: sp.a,
    // Atlas uv is measured *from the top-left of atlas.png*, matching the PNG's own row order and
    // the flipY=false upload in web/js/main.js. v0 is therefore the sprite's top row. (GL's usual
    // bottom-up uv would need v0 = 1 - (y+h)/AS; that convention silently draws every sprite upside
    // down once the image is uploaded without flipping.)
    u0: c.x / AS, v0: c.y / AS,
    u1: (c.x + c.w) / AS, v1: (c.y + c.h) / AS,
  };
});
// texture id (as used in quads) -> packed cell, resolved once

// For a solid box built from quads, opacity is the six planes it shows to the world, not every quad
// it happens to contain: grass_block is opaque even though its side overlay is a cutout sprite.
for (const s of states) {
  if (!s.fc || !s.g) continue;
  let op = 1;
  for (const arm of s.g) {
    const shown = new Array(6).fill(-1);
    for (const qi of arm) {
      const pk = quadRefs[qi * 2 + 1];
      const d = ((pk >> 12) & 7) - 1;
      if (d >= 0 && shown[d] < 0) shown[d] = pk & 0xfff;
    }
    if (shown.some((t) => t < 0 || textures[t].kind !== 0)) { op = 0; break; }
  }
  s.op = op;
}


// normalise: invisible states carry no geometry, the mesher skips them
for (const s of states) if (!s.cube && !s.g?.length) { s.r = 3; delete s.g; }
fs.mkdirSync(OUT, { recursive: true });
// ---- binary geometry blob --------------------------------------------------
// Quantised so the browser never parses JSON for the bulk of the payload:
//   geometry record: 12 x int16 positions (model units * 256, range +-128) + 8 x uint16 sprite uv
//   quad record:     uint32 geometry index, uint32 tex | (dir+1)<<12 | (cullface+1)<<15 | shade<<18 | tint<<19
// Sprite uv stays in 0..1 of the source texture; the mesher maps it into the atlas with the
// u0/v0/u1/v1 in `textures`, which keeps geometry independent of the atlas layout.
const geoms = geomPos.length / 12;
const quads = quadRefs.length / 2;
const HEADER = 32;
const buf = Buffer.alloc(HEADER + geoms * 40 + quads * 8);
buf.write('DVGEO12 ', 0, 'ascii');
buf.writeUInt32LE(geoms, 8);
buf.writeUInt32LE(quads, 12);
buf.writeUInt32LE(POS_SCALE, 16);
let o = HEADER;
for (const v of geomPos) {
  if (v < -32768 || v > 32767) { resolver.note(`element vertex ${v / POS_SCALE} is too far outside the block to encode`); }
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), o); o += 2;
}
for (const v of geomUv) { buf.writeUInt16LE(Math.max(0, Math.min(65535, v)), o); o += 2; }
for (const v of quadRefs) { buf.writeUInt32LE(v, o); o += 4; }
fs.writeFileSync(path.join(OUT, 'geometry.bin'), buf);

const missing = [...resolver.missing.entries()].sort((a, b) => b[1] - a[1]);
const out = {
  version: 1,
  generated: Date.now(),
  world: census.world,
  atlasSize: packed.size,
  dirs: ['down', 'up', 'north', 'south', 'west', 'east'],
  uvT: UV_TRANSFORMS,
  textures,
  states,
  geometry: {
    file: 'geometry.bin',
    geoms,
    quads,
    posScale: POS_SCALE,
  },
};
fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify(out));
fs.writeFileSync(path.join(OUT, 'atlas.png'), encodePngRgba(packed.size, packed.size, packed.rgba));

const samplesOf = new Map(census.states.map(s => [s.key, s.samples]));
let wTotal = 0, wOk = 0, wAir = 0;
for (const s of states) {
  const w = samplesOf.get(s.k) ?? 0;
  wTotal += w;
  if (s.g?.length || s.cube?.length) wOk += w;
  else if (AIRS.has(s.k.split('|')[0])) wAir += w;
}
const visible = states.filter(s => s.g?.length || s.cube?.length).length;

const report = {
  states: states.length,
  statesWithGeometry: visible,
  statesCubeFastPath: cubesFast,
  statesInvisibleOrMissing: states.length - visible,
  statesCubeFallbackNoElements: builtinModel,
  coverageBySectionSamples: `${(100 * (wOk + wAir) / Math.max(1, wTotal)).toFixed(2)}% of samples`,
  coverageUnmatchedSamples: wTotal - wOk - wAir,
  quads,
  texturesPacked: textures.length,
  texturesMissing: texList.filter(t => !t.img).length,
  texturesAnimated: textures.filter(t => t.anim).length,
  uvClamped: bakeStats.uvClamped,
  atlasSize: packed.size,
  missingAssets: missing.slice(0, 60),
  missingTotal: missing.length,
  unpackedTextures: unpacked.slice(0, 60),
  unpackedTotal: unpacked.length,
  notes: [...resolver.notes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
index.close();
