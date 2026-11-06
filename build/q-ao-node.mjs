import { Assets } from '../web/js/assets.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { readFileSync } from 'node:fs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';

const g = readFileSync('build/assets/geometry.bin');
const assets = new Assets(JSON.parse(readFileSync('build/assets/atlas.json', 'utf8')),
  g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const ID = {};
assets.states.forEach((s, i) => { if (!ID[s.name]) ID[s.name] = i + 1; });
const gravel = ID['minecraft:gravel'] ?? ID['gravel'];
const frame = (v) => new Uint16Array(256).fill(v + HEIGHT_BIAS);
const get = (cx, cz) => (cx === 0 && cz === 0 ? {
  cx: 0, cz: 0, height: frame(100), ground: frame(100),
  cover: new Uint16Array(256), state: new Uint16Array(256).fill(gravel),
} : null);
console.log("keys", Object.keys(meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 8 }).stream));
const avg = (s) => {
  let n = 0; const c = [0, 0, 0];
  for (let i = 0; i < s.count * 4; i += 4) { n++; for (let k = 0; k < 3; k++) c[k] += s.color[i + k]; }
  return c.map((v) => Math.round(v / n));
};
for (const ao of [1, 0.931, 0.86]) {
  const flat = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 8, aoFar: ao });
  const tex = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 8, aoFar: ao, tex: true });
  console.log('aoFar', ao, 'plate', JSON.stringify(avg(flat.stream)), 'textured', JSON.stringify(avg(tex.stream)));
}
