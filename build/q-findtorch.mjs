// Find a torch-lit mine the camera can look into: a cell the save gives strong block light while
// skylight says it is covered, close enough to the surface that a face is exposed to the sky.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});
const cls = classifyStates(atlas.states, atlas.textures);
const opaque = (id) => id && id > 0 && cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const found = [];
for (let cz = +(process.env.C0 ?? -24); cz <= +(process.env.C1 ?? 24); cz++) {
  for (let cx = +(process.env.C0 ?? -24); cx <= +(process.env.C1 ?? 24); cx++) {
    const bytes = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!bytes || bytes.length < 64) continue;
    const c = openChunk(bytes);
    const surf = (x, z) => c.surfaceAt(x, z);
    for (const sec of c.sections) {
      for (let ly = 0; ly < 16; ly++) for (let lz = 1; lz < 15; lz++) for (let lx = 1; lx < 15; lx++) {
        const y = sec.y * 16 + ly;
        const lv = c.lightAt(lx, y, lz);
        if (!lv || lv[1] < 12 || lv[0] > 3) continue;
        const top = surf(lx, lz);
        if (top - y > 26 || top - y < 1) continue;                    // near the surface, covered
        const id = c.stateAt(lx, y, lz);
        if (opaque(id)) continue;                                      // want the air the torch lights
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!opaque(c.stateAt(lx + dx, y, lz + dz))) continue;       // a wall to light up
          const s2 = c.lightAt(lx + dx, y, lz + dz);
          if (s2 && s2[1] >= 8 && s2[0] <= 4) { found.push({ x: cx * 16 + lx, y, z: cz * 16 + lz, blk: lv[1], top }); break; }
        }
      }
    }
  }
}
const by = new Map();
for (const f of found) {
  const k = `${f.x >> 4},${f.z >> 4}`;
  const a = by.get(k) ?? { n: 0, x: 0, y: 0, z: 0, maxblk: 0, top: 0 };
  a.n++; a.x += f.x; a.y += f.y; a.z += f.z; a.maxblk = Math.max(a.maxblk, f.blk); a.top = Math.max(a.top, f.top);
  by.set(k, a);
}
console.log(JSON.stringify([...by.values()].map((a) => ({
  n: a.n, x: Math.round(a.x / a.n), y: Math.round(a.y / a.n), z: Math.round(a.z / a.n), maxblk: a.maxblk, top: a.top,
})).sort((p, q) => q.n - p.n).slice(0, 8)));
