import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const idB = assets.json.states.findIndex((s) => s.k === 'minecraft:grass_block|snowy=false') + 1;
const height = new Uint16Array(256).fill(HEIGHT_BIAS + 101);
const state = new Uint16Array(256).fill(idB);
const sh = { cx: 0, cz: 0, height, state };
const { stream: st, stats } = meshShellPatch(assets, (cx, cz) => (cx === 0 && cz === 0 ? sh : null), 0, 0, 1, 1,
  { maxSkirt: 8, trackStates: true });
console.log('count', st.count, 'stats', stats);
for (let q = 0; q < Math.min(st.count, 60); q += 6) {
  const V = (i) => [st.position[i * 3], st.position[i * 3 + 1], st.position[i * 3 + 2]];
  console.log(q, JSON.stringify([V(q), V(q + 1), V(q + 2), V(q + 3)]),
    'col', [st.color[q * 4], st.color[q * 4 + 1], st.color[q * 4 + 2]], 'state', st.stateIds?.[q / 6]);
}
