// The one odd group in the browser probe was a plant quad whose face brightness did not follow the
// light of the air cell beside it. Directionless quads (cross models) take the light of the block
// they belong to, exactly as vanilla does - so check that a plant really can sit in daylight while
// the cell next to it is dark.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});
const plant = new Map(atlas.states.map((s, i) => [i + 1, s.k]));
let litPlant = 0, darkSide = 0, samples = 0;
for (let cz = -5; cz <= 1; cz++) {
  for (let cx = 1; cx <= 4; cx++) {
    const bytes = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!bytes || bytes.length < 64) continue;
    const c = openChunk(bytes);
    for (const sec of c.sections) {
      for (let ly = 0; ly < 16; ly++) for (let lz = 1; lz < 15; lz++) for (let lx = 1; lx < 15; lx++) {
        const y = sec.y * 16 + ly;
        const id = c.stateAt(lx, y, lz);
        const k = plant.get(id) ?? '';
        if (!/(^|:)(grass|fern|tall_grass|bamboo)(\||$)/.test(k)) continue;
        samples++;
        const own = c.lightAt(lx, y, lz), side = c.lightAt(lx + 1, y, lz);
        if (own[0] >= 13) litPlant++;
        if (own[0] >= 13 && side[0] <= 2) darkSide++;
      }
    }
  }
}
console.log(`plant cells sampled ${samples}, in daylight ${litPlant}, daylight with a dark side neighbour ${darkSide}`);
