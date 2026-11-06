// Where are the trees? Not in the heightmaps: leaves block motion in Minecraft, so WORLD_SURFACE and
// MOTION_BLOCKING agree right through a canopy. The only honest way to find a tree is to read the voxels
// the renderer reads: a leaves state on top with a log state a few blocks below it.
//
//   node build/find-tree.mjs [--cx 186 --cz 125 --r 6]
import { readFileSync } from 'node:fs';
import { openChunk } from '../server/chunk-payload.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'http://127.0.0.1:8765');
const dim = arg('dim', 'overworld');
const cx0 = +arg('cx', 186), cz0 = +arg('cz', 125), R = +arg('r', 6);
const atlas = JSON.parse(readFileSync(arg('assets', 'build/assets/atlas.json'), 'utf8'));
const key = (id) => (id > 0 && id <= atlas.states.length ? atlas.states[id - 1].k : '');

const blobs = [];
let miss = 0, seen = 0;
for (let cz = cz0 - R; cz <= cz0 + R; cz++) {
  for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
    const r = await fetch(`${base}/voxel?dim=${encodeURIComponent(dim)}&cx=${cx}&cz=${cz}`);
    if (!r.ok) { miss++; continue; }
    const c = openChunk(Buffer.from(await r.arrayBuffer()));
    seen++;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const top = c.surfaceAt(lx, lz);
        if (!key(c.stateAt(lx, top - 1, lz)).includes('leaves')) continue;
        let trunk = 0;
        for (let d = 2; d <= 8; d++) {
          const k = key(c.stateAt(lx, top - d, lz));
          if (/(log|wood|trunk|stem)/.test(k)) { trunk = d; break; }
        }
        if (!trunk) continue;
        let n = 1;                                    // count the canopy around it
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const nx = lx + dx, nz = lz + dz;
            if (nx < 0 || nz < 0 || nx > 15 || nz > 15) continue;
            if (key(c.stateAt(nx, c.surfaceAt(nx, nz) - 1, nz)).includes('leaves')) n++;
          }
        }
        blobs.push({ n, trunk, x: c.cx * 16 + lx, y: top, z: c.cz * 16 + lz,
          top: key(c.stateAt(lx, top - 1, lz)), stem: key(c.stateAt(lx, top - trunk, lz)) });
      }
    }
  }
}
blobs.sort((a, b) => b.trunk - a.trunk || b.n - a.n);
console.log(`chunks ${seen}, missing ${miss}, tree columns ${blobs.length}`);
for (const b of blobs.slice(0, 10)) {
  console.log(`  goto=${b.x},${b.y},${b.z}  trunk ${b.trunk} blocks, canopy ${b.n}/9 cols`);
  console.log(`     cap ${b.top}`);
  console.log(`     stem ${b.stem}`);
}
