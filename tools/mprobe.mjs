// Ad-hoc probe: how much geometry a real chunk meshes, split by pass, with AO stats.
//   node tools/mprobe.mjs [cx] [cz]
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { meshChunk, AO_LEVEL } from '../web/js/mesher.js';
import { openChunk, openBatch } from '../web/js/payload.js';
import { WorldService, packBatch } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const CX = Number(process.argv[2] ?? 3), CZ = Number(process.argv[3] ?? 3);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null);

const raw = svc.batchBytes('minecraft:overworld', CX - 1, CZ - 1, 3, 3);
const halo = new Map(openBatch(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  .filter(Boolean).map((c) => [`${c.cx},${c.cz}`, c]));
const chunk = halo.get(`${CX},${CZ}`);

const at = (cx, cz, lx, ly, lz) => {
  const c = halo.get(`${cx + (lx >> 4)},${cz + (lz >> 4)}`);
  if (!c) return -1;
  const s = c.sectionAt(ly);
  if (!s) return -1;
  const x = lx & 15, z = lz & 15;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
  return id === 0 ? -1 : id - 1;
};

const r = meshChunk(assets, chunk, at);
console.log('chunk', CX, CZ, 'streams(verts)', r.streams.map((s) => s.count));
console.log('stats', r.stats);

// colour spread of the opaque pass: how much AO actually varied
const col = r.streams[0].color;
let min = 255, max = 0;
const hist = new Map();
for (let i = 0; i < col.length; i += 4) {
  const v = col[i];
  if (v < min) min = v;
  if (v > max) max = v;
  hist.set(v, (hist.get(v) ?? 0) + 1);
}
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('opaque R channel min/max', min, max, 'distinct', hist.size);
console.log('most common R values', top.map(([v, n]) => `${v}:${n}`).join(' '));
console.log('AO_LEVEL', AO_LEVEL);
