// dbg-waterpos — find a water surface and a bare stone surface near spawn so a close-up probe can
// look at both with detail geometry (big quads, no shell decimation).
import { readFileSync } from 'node:fs';
import { openShellFrame } from '../web/js/payload.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(a.states, a.textures);
const ids = buildStateIds(a.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});
const want = { water: ids.get('minecraft:water|level=0'), stone: ids.get('minecraft:stone'),
  sand: ids.get('minecraft:sand') };
const found = {};
for (let cz = -8; cz <= 8 && Object.keys(found).length < 3; cz++) {
  for (let cx = -8; cx <= 8 && Object.keys(found).length < 3; cx++) {
    const raw = svc.shellBytes('minecraft:overworld', cx, cz);
    if (!raw) continue;
    const sh = openShellFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = (z << 4) | x;
        for (const [name, id] of Object.entries(want)) {
          if (found[name] || sh.state[i] !== id) continue;
          const h = sh.height[i] - 2048;
          // want it in the open: a column of at least 8 air blocks above
          found[name] = [cx * 16 + x, h, cz * 16 + z];
        }
      }
    }
  }
}
console.log(JSON.stringify(found));
