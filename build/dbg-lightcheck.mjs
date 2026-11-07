// What does the payload itself say about light at the cave coordinate? The browser's `litAt` said 0 at
// the cavern floor and at the canopy, which would be news: the canopy stands open to the sky.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openChunk } from '../web/js/payload.js';
import { lightLevels } from '../shared/light.mjs';

const json = JSON.parse(fs.readFileSync('build/census.json', 'utf8'));
const ids = buildStateIds(json.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {});
const CX = 127, CZ = 169;
const buf = await svc.chunkBytes('minecraft:overworld', CX, CZ);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const c = openChunk(ab, 0);
console.log(`chunk ${CX},${CZ} yMin ${c.yMin} yCount ${c.yCount} light? ${c.hasLight ?? '?'}`);
const cols = process.argv[2] ? process.argv.slice(2).map((a) => { const [cx, cz, x, z] = a.split(':').map(Number); return { cx, cz, x, z }; }) : [{ cx: CX, cz: CZ, x: 10, z: 14 }];
for (const col of cols) {
  const cx = col.cx, cz = col.cz, lx = col.x, lz = col.z;
  const b2 = await svc.chunkBytes('minecraft:overworld', cx, cz);
  const c2 = openChunk(b2.buffer.slice(b2.byteOffset, b2.byteOffset + b2.byteLength), 0);
  const surf = c2.surfaceAt(lx, lz);
  console.log(`chunk ${cx},${cz} local ${lx},${lz} world (${cx * 16 + lx}, ${cz * 16 + lz}) surface ${surf}`);
  for (const y of [13, 29, 69, surf - 1, surf, surf + 1, surf + 4, surf + 16, surf + 40]) {
    const lv = lightLevels(c2.sectionAt, lx, y, lz);
    console.log(`  y${String(y).padStart(4)}: sky/blk ${lv ? lv.join('/') : 'none'}`);
  }
}
if (0) {
  for (const y of [13, 29, 69, 73, 74, 80, 120]) {
    const s = c.sectionAt(y);
    const lv = lightLevels(c.sectionAt, lx, y, lz);
    console.log(`  x${CX * 16 + lx} y${y} z${CZ * 16 + lz}: section ${s ? 'yes' : 'no'} sky/blk ${lv ? lv.join('/') : 'none'}`);
  }
}
