// Find a torch-lit tunnel a camera can float inside: a straight run of non-opaque cells that the
// save lights strongly, so an orbit target placed in it sees cave wall rather than rock.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('minecraft' ? 'DarkRPG/world' : '', buildStateIds(atlas.states.map((s) => s.k)), null, {});
const cls = classifyStates(atlas.states, atlas.textures);
const solid = (id) => id && id > 0 && cls.cube[id - 1] === 1;
const LEN = +(process.env.LEN ?? 18);
const out = [];
for (let cz = -24; cz <= 24; cz++) {
  for (let cx = -24; cx <= 24; cx++) {
    const bytes = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!bytes || bytes.length < 64) continue;
    const c = openChunk(bytes);
    for (const sec of c.sections) {
      for (let ly = 1; ly < 15; ly += 2) for (let lz = 1; lz < 15; lz += 2) for (let lx = 1; lx < 15; lx += 2) {
        const y = sec.y * 16 + ly;
        const lv = c.lightAt(lx, y, lz);
        if (!lv || lv[1] < 12 || lv[0] > 3) continue;
        if (solid(c.stateAt(lx, y, lz)) || solid(c.stateAt(lx, y + 1, lz))) continue;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          let n = 0;
          while (n < LEN) {
            const px = lx + dx * n, pz = lz + dz * n;
            if (px > 15 || pz > 15) break;
            if (solid(c.stateAt(px, y, pz)) || solid(c.stateAt(px, y + 1, pz))) break;
            const s = c.lightAt(px, y, pz);
            if (!s || s[1] < 6) break;
            n++;
          }
          if (n >= LEN) out.push({ x: cx * 16 + lx + dx * (n >> 1), y, z: cz * 16 + lz + dz * (n >> 1), len: n, blk: lv[1], top: c.surfaceAt(lx, lz) });
        }
      }
    }
  }
}
out.sort((a, b) => b.len - a.len);
console.log(JSON.stringify(out.slice(0, 10)));
