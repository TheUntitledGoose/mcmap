import { openShellFrame } from '../web/js/payload.js';
const r = await fetch('http://127.0.0.1:8765/shell?dim=minecraft:overworld&cx=186&cz=125');
const ab = await r.arrayBuffer();
const sh = openShellFrame(ab);
const KEY = (x, z) => (z << 4) | x;
for (const [x, z] of [[7, 15], [8, 15], [4, 12], [0, 0], [15, 15]]) {
  const k = KEY(x, z);
  console.log(`x=${x} z=${z} surface=${sh.surfaceAt(x, z)} ground=${sh.groundAt(x, z)}`,
    'cover=', sh.states ? '' : (sh.coverAt(x, z)), 'paint=', sh.stateAt(x, z));
}
// name the ids
const a = await (await fetch('http://127.0.0.1:8765/assets/atlas.json')).json();
const nm = (id) => (id ? (a.states[id - 1]?.k ?? `?${id}`) : 'none');
for (const [x, z] of [[7, 15], [8, 15], [4, 12], [0, 0], [15, 15]]) {
  const k = KEY(x, z);
  console.log(`  (${x},${z}) surf ${sh.surfaceAt(x, z)} cover ${nm(sh.coverAt(x, z))} | ground ${sh.groundAt(x, z)} paint ${nm(sh.stateAt(x, z))}`);
}
