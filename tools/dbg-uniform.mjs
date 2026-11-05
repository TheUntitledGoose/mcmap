import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
const WORLD = 'DarkRPG/world', ATLAS = 'build/assets/atlas.json';
const a = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
const svc = new WorldService(WORLD, buildStateIds(a.states.map((s) => s.k)), null);
const cls = classifyStates(a.states, a.textures);
const c = openChunk(svc.chunkBytes('minecraft:overworld', 3, 3));
for (const s of c.sections) {
  if (!s.single) continue;
  const id = c.palette[s.single - 1] - 1;
  console.log(`y=${s.y * 16} slot ${s.single} id ${id} cube=${a.states[id]?.cube ? 1 : 0} fc=${a.states[id]?.fc ?? 0} cubeCls=${cls.cube[id]} ${a.states[id]?.k}`);
}
