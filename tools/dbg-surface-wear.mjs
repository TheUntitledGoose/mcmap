// What the surface of a chunk is really wearing: for each column, the WORLD_SURFACE block and the
// cube the shell currently falls back to, with the sprite mean each one would paint. This is the
// difference between "the world looks brown" and "the world looks green".
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets, decodeFaceCode } from '../web/js/assets.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});

const CX = +(process.argv[2] ?? 3), CZ = +(process.argv[3] ?? 3);
const raw = svc.chunkBytes('minecraft:overworld', CX, CZ);
const c = openChunk(raw);
const isCube = (id) => id && cls.cube[id - 1] === 1;

// First sprite face the mesher can colour with, and the mean colour it would produce.
function paint(id, face = 1) {
  const st = assets.states[id - 1];
  if (!st) return null;
  let cell = null;
  if (st.cube) cell = assets.texCell(decodeFaceCode(st.cube[0][face])[0]);
  else if (st.g?.length) {
    for (const gi of st.g[0]) {
      const t = assets.ref[gi * 2] & 0xfff;
      const cc = assets.texCell(t);
      if (cc && cc.kind !== 3) { cell = cc; break; }
    }
  }
  return cell && cell.kind !== 3 ? { id: cell.id, c: cell.c, g: cell.g } : null;
}

const tally = new Map();
for (let z = 0; z < 16; z++) {
  for (let x = 0; x < 16; x++) {
    const i = (z << 4) | x;
    const top = c.height[i] - HEIGHT_BIAS;
    const surf = c.stateAt(x, top, z);
    if (!surf) continue;
    let cube = surf;
    if (!isCube(surf)) {
      for (let k = 1; k <= 5; k++) {
        const b = c.stateAt(x, top - k, z);
        if (b && isCube(b)) { cube = b; break; }
      }
    }
    const key = `${assets.states[surf - 1].k} => ${cube === surf ? '(same)' : assets.states[cube - 1].k}`;
    let e = tally.get(key);
    if (!e) tally.set(key, (e = { n: 0, surf: [], cube: [] }));
    e.n++;
    e.surf = e.surf.length ? e.surf : paint(surf);
    e.cube = e.cube.length ? e.cube : paint(cube);
  }
}
const rows = [...tally.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25);
console.log(`chunk ${CX},${CZ}: surface state => shell state, columns, sprite means`);
for (const [k, e] of rows) {
  console.log(`${String(e.n).padStart(4)}  ${k}`);
  console.log(`      surface ${JSON.stringify(e.surf)}`);
  console.log(`      shell   ${JSON.stringify(e.cube)}`);
}
