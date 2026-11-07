// Find a flat, unobstructed stretch of GROUND to walk on, scored by the physics itself rather than by
// the heightmap: the heightmap says "canopy", the body says "hole". A candidate counts only if the body
// lands on soil (grass/dirt/stone/sand...), has clear air above its head, and then covers the distance
// its speed says it should.
//
//   node build/find-walk.mjs [chunkX0] [chunkZ0] [chunkW] [chunkH]   # default 6 4 8 6
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { makeCellAt } from '../web/js/collision.js';
import { newPlayer, simulate, hits, floorTop } from '../shared/player.mjs';

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
const nameOf = (id) => (id > 0 && id <= json.states.length ? json.states[id - 1].k : '?');

const GROUND = /grass_block|dirt|stone|sand|gravel|clay|snow|podzol|mycelium|coarse|path|mud|ice|silt|grass_block|bedrock|ore$/;

const held = new Map();
async function load(cx0, cz0, w, h) {
  for (let cx = cx0; cx < cx0 + w; cx++) {
    for (let cz = cz0; cz < cz0 + h; cz++) {
      const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
      if (!buf) continue;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (!held.has(cx)) held.set(cx, new Map());
      held.get(cx).set(cz, openChunk(ab, 0));
    }
  }
  return makeCellAt((cx, cz) => held.get(cx)?.get(cz) || null, () => assets);
}

const [cx0, cz0, W, H] = [Number(process.argv[2] ?? 6), Number(process.argv[3] ?? 4),
  Number(process.argv[4] ?? 8), Number(process.argv[5] ?? 6)];
const cellAt = await load(cx0, cz0, W, H);
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const cands = [];
for (let x = cx0 * 16 + 3; x < (cx0 + W) * 16 - 3; x += 5) {
  for (let z = cz0 * 16 + 3; z < (cz0 + H) * 16 - 3; z += 5) {
    const p = newPlayer(x + 0.5, 250, z + 0.5);
    let n = 0;
    while (!p.onGround && n < 500) { simulate(p, {}, 1 / 60, cellAt, { minY: -64 }); n++; }
    if (!p.onGround) continue;
    const ch = held.get(x >> 4)?.get(z >> 4);
    const under = ch ? nameOf(ch.stateAt(x & 15, Math.round(p.y) - 1, z & 15)) : '?';
    if (!GROUND.test(under.split('|')[0])) continue;         // landed on a tree, a roof, or a plant
    if (ch && ch.stateAt(x & 15, Math.round(p.y) + 2, z & 15) !== 1) continue;   // headroom (id 1 = air)
    for (const [dx, dz] of DIRS) {
      const q = newPlayer(p.x, p.y, p.z);
      let air = 0, rock = 0, frozen = 0, maxDrop = 0;
      const y0 = q.y;
      for (let i = 0; i < 120; i++) {                        // 2 s sprint
        const ev = simulate(q, { fx: dz ? 0 : dx, fz: dz ? dz : 0, sprint: 1 }, 1 / 60, cellAt, { minY: -64 });
        if (!q.onGround) air++;
        if (ev.frozen) frozen++;
        if (hits(cellAt, q.x, q.y, q.z)) rock++;
        maxDrop = Math.max(maxDrop, y0 - q.y);
      }
      const travelled = Math.abs(dx ? q.x - p.x : q.z - p.z);
      cands.push({ x, z, y0, under, dir: `${dx},${dz}`, travelled, air, rock, frozen,
        maxDrop: +maxDrop.toFixed(1) });
    }
  }
}
cands.sort((a, b) => (b.travelled - b.air * 0.2 - b.maxDrop) - (a.travelled - a.air * 0.2 - a.maxDrop));
console.log(`best walking stretches around chunk ${cx0},${cz0} (2 s sprint, expect ~11 blocks):`);
for (const c of cands.slice(0, 12)) {
  console.log(`  goto ${c.x + 0.5},${c.y0},${c.z + 0.5} dir ${c.dir}: covered ${c.travelled.toFixed(1)} blocks` +
    `, air ${c.air}/120, drop ${c.maxDrop}, in-rock ${c.rock}, frozen ${c.frozen}, on ${c.under}`);
}
