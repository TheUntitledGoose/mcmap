import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates({ states: atlas.states, textures: atlas.textures });
const idOf = (k) => atlas.states.findIndex((s) => s.k === k) + 1;
const nm = (id) => (id ? (atlas.states[id - 1]?.k ?? `?${id}`) : 'none');
const svc = new WorldService('DarkRPG/world', {
  isPaintState: (id) => (id >= 1 && id <= atlas.states.length
    ? cls.cube[id - 1] && cls.opaque[id - 1] : 0),
  isSolidState: (id) => (id >= 1 && id <= atlas.states.length ? cls.cube[id - 1] : 0),
});
const ch = await svc.chunkBytes('minecraft:overworld', 186, 125);
const sh = await svc.shellFromPayload(ch, cls);
console.log('shell magic ok, cols', sh.height.length);
const KEY = (x, z) => (z << 4) | x;
for (const [x, z] of [[0, 7], [7, 15], [4, 12], [0, 0]]) {
  console.log(`(${x},${z}) surf ${sh.height[KEY(x,z)] - 2048} cover ${nm(sh.cover[KEY(x,z)])}` +
    ` | ground ${sh.ground[KEY(x,z)] - 2048} paint ${nm(sh.state[KEY(x,z)])}`);
}
// what is actually in the column, from the payload
console.log('column (0,7) top-down:');
for (let y = 66; y >= 30; y--) {
  const id = ch.stateAt(0, y, 7);
  if (y % 3 === 0 || id !== 20) console.log('  y', y, nm(id));
}
