// How far down does the dark band go around the walk-cave column? The payload says skylight 0 at the
// cavern floor AND at open air y 74..89 above the canopy, with 15 only by y 113. Is that this column or
// the region? A 3x3 chunk grid at three heights answers it in one pass.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openChunk } from '../web/js/payload.js';
import { lightLevels } from '../shared/light.mjs';

const json = JSON.parse(fs.readFileSync('build/census.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
const cache = new Map();
const get = async (cx, cz) => {
  const k = `${cx},${cz}`;
  if (cache.has(k)) return cache.get(k);
  const b = await svc.chunkBytes('minecraft:overworld', cx, cz);
  const c = b ? openChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 0) : null;
  cache.set(k, c); return c;
};
for (const y of [74, 89, 105, 121]) {
  let row = `y ${String(y).padStart(3)}: `;
  for (let cz = 168; cz <= 170; cz++) {
    for (let cx = 126; cx <= 128; cx++) {
      const c = await get(cx, cz);
      const lv = c ? lightLevels(c.sectionAt, 8, y, 8) : null;
      row += ` ${c ? (lv ? lv[0] : '?') : '-'}`;
    }
  }
  console.log(row + '   (chunks 126..128 x 168..170, local 8,8)');
}
