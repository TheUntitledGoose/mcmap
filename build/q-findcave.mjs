// Where is a cave mouth a browser can actually point a camera at?  Decode real payloads (the same
// bytes worldd serves) and look for the shape daylight makes: an air cell that is dark, sitting under
// an air cell that is bright, with daylight on one side and rock on the other.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const stateIds = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', stateIds, null, {});
const cls = classifyStates(atlas.states, atlas.textures);
const C0 = +(process.env.C0 ?? -16), C1 = +(process.env.C1 ?? 16);

const idAt = (c, x, y, z) => {
  const s = c.sectionAt(y);
  if (!s) return null;
  return c.stateAt(x & 15, y, z & 15);
};
const opaque = (id) => id && id > 0 && cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const mouths = [], darkAir = [];
for (let cz = C0; cz <= C1; cz++) {
  for (let cx = C0; cx <= C1; cx++) {
    const bytes = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!bytes || bytes.length < 64) continue;
    const c = openChunk(bytes);
    for (const sec of c.sections) {
      const y0 = sec.y * 16;
      for (let ly = 0; ly < 16; ly++) {
        const y = y0 + ly;
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const lv = c.lightAt(lx, y, lz);
            if (!lv || lv[0] > 6) continue;
            const id = idAt(c, cx, y, lz);
            if (id === null || opaque(id)) continue;                 // want an air-ish cell
            const up = c.lightAt(lx, y + 1, lz);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = lx + dx, nz = lz + dz;
              const side = c.lightAt(nx, y, nz);
              if (!side || side[0] < 13) continue;
              const back = c.lightAt(lx - dx, y, lz - dz);
              const bid = idAt(c, cx, y, lz - dz);
              if (!back || back[0] < 0 || !opaque(bid)) continue;
              if (up && up[0] >= 12) mouths.push({ x: cx * 16 + lx, y, z: cz * 16 + lz, sky: lv[0], blk: lv[1] });
              break;
            }
            if (lv[0] <= 3) darkAir.push({ x: cx * 16 + lx, y, z: cz * 16 + lz, sky: lv[0] });
          }
        }
      }
    }
  }
}
const clusters = (list, keep = 6) => {
  const by = new Map();
  for (const m of list) {
    const k = `${m.x >> 4},${m.z >> 4}`;
    const a = by.get(k) ?? { n: 0, x: 0, y: 0, z: 0, maxy: -999 };
    a.n++; a.x += m.x; a.y += m.y; a.z += m.z; a.maxy = Math.max(a.maxy, m.y);
    by.set(k, a);
  }
  return [...by.values()].map((a) => ({ n: a.n, x: Math.round(a.x / a.n), y: Math.round(a.y / a.n), topY: a.maxy, z: Math.round(a.z / a.n) }))
    .sort((p, q) => q.n - p.n).slice(0, keep);
};
console.log('cave mouths (daylight pouring in):', JSON.stringify(clusters(mouths)));
console.log('dark air near a lit side:', JSON.stringify(clusters(darkAir)));
