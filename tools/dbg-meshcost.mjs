// Why does one chunk cost ~30 ms to mesh? Count what the mesher actually walks over: sections,
// uniform sections (one state repeated 4096 times, i.e. most of the underground), air sections,
// and the face-cull tests it pays for before deciding a face is invisible.
import { readFileSync } from 'node:fs';
import { openChunk } from '../web/js/payload.js';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const geob = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, geob.buffer.slice(geob.byteOffset, geob.byteOffset + geob.length));
const svc = new WorldService('DarkRPG/world', buildStateIds(a.states.map((s) => s.k)), 'build/cache', {});

const coords = process.argv.slice(2);
if (!coords.length) coords.push('3,3', '3,4', '0,0', '-4,-4', '10,10');
let t = 0, n = 0;
for (const cs of coords) {
  const [cx, cz] = cs.split(',').map(Number);
  const raw = svc.chunkBytes('minecraft:overworld', cx, cz);
  const c = openChunk(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const secs = c.sections;
  let uni = 0, airS = 0, mixed = 0, vox = 0, distinct = 0;
  for (const s of secs) {
    // a section's `data` is a flat 16x16x16 of palette ids
    if (s.single) { uni++; vox += 4096; distinct++; continue; }
    let min = 65535, max = 0;
    for (const v of s.vox) { if (v < min) min = v; if (v > max) max = v; }
    if (max === 0) { airS++; continue; }
    if (min === max) uni++; else mixed++;
    vox += s.vox.length;
    distinct += new Set(s.vox).size;
  }
  const at = (ccx, ccz, lx, ly, lz) => {
    if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && ccx === c.cx && ccz === c.cz) return c.stateAt(lx, ly, lz);
    return 0;                                              // unknown neighbour: nothing to cull against
  };
  const t0 = performance.now();
  const { stats } = meshChunk(assets, c, at);
  const dt = performance.now() - t0;
  t += dt; n++;
  console.log(`${cs.padEnd(8)} ${String(dt.toFixed(1)).padStart(6)} ms  sections ${String(secs.length).padStart(2)}` +
    ` air ${String(airS).padStart(2)} uniform ${String(uni).padStart(2)} mixed ${String(mixed).padStart(2)}` +
    `  voxels walked ${String(vox).padStart(6)}  cubes ${stats.cubes} faces ${stats.faces} culled ${stats.culled}`);
}
console.log(`mean ${((t / n) * 1000).toFixed(0)} us/chunk`);
