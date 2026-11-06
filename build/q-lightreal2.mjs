// Replicate the browser's meshing of a real chunk in Node and ask whether the light field changes
// the vertex colours at all. Same modules, same payload bytes the browser fetches.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { combineLight, lightLevels } from '../shared/light.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});

const CCX = +(process.env.CX ?? 2), CCZ = +(process.env.CZ ?? -3);
const R = 1;
const map = new Map();
for (let cz = CCZ - R; cz <= CCZ + R; cz++) {
  for (let cx = CCX - R; cx <= CCX + R; cx++) {
    const bytes = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!bytes) continue;
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    map.set(`${cx},${cz}`, openChunk(ab, 0, ab.byteLength));
  }
}
const get = (cx, cz) => map.get(`${cx},${cz}`);
console.log('chunks', map.size, 'centre', `${CCX},${CCZ}`);
const centre = get(CCX, CCZ);
console.log('sections', centre.sections.length,
  'light codes', centre.sections.slice(0, 6).map((s) => `${s.y}:${s.sky}/${s.blk}`).join(' '));

const stateAt = (cx, cz, lx, ly, lz) => {
  const c = get(cx + (lx >> 4), cz + (lz >> 4));
  if (!c) return -1;
  const s = c.sectionAt(ly);
  if (!s) return -1;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
  return id === 0 ? -1 : id - 1;
};
const lightAt = (cx, cz, lx, ly, lz, scale = 1) => {
  const c = get(cx + (lx >> 4), cz + (lz >> 4));
  if (!c) return -1;
  const lv = lightLevels(c.sectionAt, lx, ly, lz);
  return lv ? combineLight(lv[0], lv[1], scale) : -1;
};
const lv = [];
for (let y = 60; y < 120; y += 4) for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) {
  const v = lightAt(CCX, CCZ, x, y, z);
  if (v >= 0) lv.push(v);
}
console.log('light sample spread', Math.min(...lv), '..', Math.max(...lv), 'of', lv.length);

const run = (opts) => {
  const r = meshChunk(assets, centre, stateAt, opts);
  const s = r.streams[0];
  const hist = new Map();
  let dark = 0, bright = 0;
  for (let i = 0; i < s.count; i++) {
    const c = Math.max(s.color[i * 4], s.color[i * 4 + 1], s.color[i * 4 + 2]);
    hist.set(c, (hist.get(c) ?? 0) + 1);
    if (c < 90) dark++; else if (c > 200) bright++;
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { stats: r.stats, verts: s.count, dark, bright, distinct: hist.size, top };
};

for (const [name, opts] of [
  ['no light (pre-M6 look)', { ao: false }],
  ['light on, no ao', { ao: false, light: (cx, cz, lx, ly, lz) => lightAt(cx, cz, lx, ly, lz), darkFloor: 0.32, darkGamma: 0.72 }],
  ['light on, darkFloor 1 (should equal no light)', { ao: false, light: (cx, cz, lx, ly, lz) => lightAt(cx, cz, lx, ly, lz), darkFloor: 1, darkGamma: 0.72 }],
]) {
  const r = run(opts);
  console.log(`\n${name}: verts ${r.verts} dark ${r.dark} bright ${r.bright} distinct colours ${r.distinct}`);
  console.log('  most common vertex brightness:', r.top.map(([c, n]) => `${c}x${n}`).join(' '));
}
