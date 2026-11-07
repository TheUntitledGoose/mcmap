// Why did the browser say cell 16 (C_FULL) at the feet of a body standing on grass at y 67? Print the
// cell code, the state key and the collision class for the columns the browser probe walked through,
// using exactly the browser modules (web/js/assets.js, payload.js, collision.js).
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { C_CLIMB, C_FULL, C_LIQUID, C_PASS, C_UNKNOWN, blocks, h16Of, liquid } from '../shared/player.mjs';

const NAME = { [-1]: 'UNKNOWN', 0: 'pass', 16: 'FULL', 32: 'CLIMB', 64: 'LIQUID' };

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});

const held = new Map();
for (let cx = 11; cx <= 13; cx++) {
  for (let cz = 9; cz <= 11; cz++) {
    const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!buf) continue;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (!held.has(cx)) held.set(cx, new Map());
    held.get(cx).set(cz, openChunk(ab, 0));
  }
}
const cellAt = makeCellAt((cx, cz) => (held.get(cx)?.get(cz)) || null, () => assets);

function keyAt(x, y, z) {
  const c = held.get(x >> 4)?.get(z >> 4);
  if (!c) return '<no chunk>';
  const id = c.stateAt(x & 15, y, z & 15);
  if (id === 0) return '<unknown id 0>';
  const s = json.states[id - 1];
  return s ? s.k : `<no state for id ${id}>`;
}

for (const [x, z] of [[193, 161], [199, 161], [200, 161], [199, 160], [192, 160], [205, 160]]) {
  const c = held.get(x >> 4)?.get(z >> 4);
  console.log(`-- world (${x},${z}) chunk ${x >> 4},${z >> 4}${c ? ` surface ${c.surfaceAt(x & 15, z & 15)}` : ' NOT HELD'}`);
  for (let y = 74; y >= 64; y--) {
    const cell = cellAt(x, y, z);
    const id = (held.get(x >> 4)?.get(z >> 4))?.stateAt(x & 15, y, z & 15);
    console.log(`   y ${String(y).padStart(3)}  ${String(NAME[cell] ?? cell).padEnd(7)} h16 ${String(h16Of(cell)).padStart(2)}`
      + ` blocks ${blocks(cell) ? 1 : 0} liq ${liquid(cell) ? 1 : 0} climb ${(cell & C_CLIMB) ? 1 : 0}`
      + `  id ${String(id).padStart(4)}  ${keyAt(x, y, z)}`);
  }
}
// What the asset table itself says about the plant names in this neighbourhood.
const names = ['minecraft:air', 'minecraft:grass', 'minecraft:grass_block|snowy=false',
  'regions_unexplored:medium_grass', 'regions_unexplored:mauve_leaves|distance=4,persistent=false,waterlogged=false',
  'minecraft:oak_fence', 'regions_unexplored:silt_grass_block'];
console.log('-- asset table opinion --');
for (const n of names) {
  const i = json.states.findIndex((s) => s.k === n);
  if (i < 0) { console.log(`   ${n}: NOT IN THE STATE TABLE`); continue; }
  const cell = assets.collisionOf(i + 1);
  console.log(`   ${n}: cell ${NAME[cell] ?? cell} h16 ${h16Of(cell)} film ${json.states[i].film ? 1 : 0} cube ${json.states[i].cube ? 1 : 0} fc ${json.states[i].fc ?? '-'}`);
}
void C_FULL; void C_LIQUID; void C_PASS; void C_UNKNOWN;
