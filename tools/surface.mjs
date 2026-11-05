// Print the top-surface block state of every column in a chunk (and the payload heightmap next
// to it). Useful for telling "the renderer drew a checkerboard" from "the world is a
// checkerboard", and it doubles as the data view for the shell/LOD pass.
// Run: node tools/surface.mjs [cx] [cz]
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openChunk } from '../web/js/payload.js';

const CX = Number(process.argv[2] ?? 0), CZ = Number(process.argv[3] ?? 0);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null);
const raw = svc.chunkBytes('minecraft:overworld', CX, CZ);
if (!raw) { console.log(`chunk ${CX},${CZ} absent`); process.exit(0); }
const c = openChunk(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const short = (k) => (k || 'air').replace('minecraft:', '').replace('regions_unexplored:', 'ru:')
  .replace(/\|.*$/, '');

const grid = [], tops = [];
for (let z = 0; z < 16; z++) {
  let row = '';
  for (let x = 0; x < 16; x++) {
    const y = c.surfaceAt(x, z);
    const id = c.stateAt(x, y, z);
    const k = id ? atlas.states[id - 1]?.k : null;
    row += short(k).padStart(9).slice(0, 9) + ' ';
    tops.push(y);
  }
  grid.push(`z${String(z).padStart(2)} ${row}`);
}
console.log(`chunk ${CX},${CZ}  top surface block (WORLD_SURFACE y+1 column top)`);
console.log('        ' + [...Array(16).keys()].map((x) => String(x % 10).padStart(9)).join(' '));
console.log(grid.join('\n'));
const hmin = Math.min(...tops), hmax = Math.max(...tops);
console.log(`height range ${hmin}..${hmax}`);
console.log('heights z0: ' + tops.slice(0, 16).join(' '));
console.log('heights z1: ' + tops.slice(16, 32).join(' '));
