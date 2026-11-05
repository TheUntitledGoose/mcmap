// Which render pass do water/glass/ice quads actually land in?
// Meshes a chunk that contains translucent blocks and looks up every triangle whose uv falls
// inside a given sprite's atlas cell, per output stream. Run: node tools/pass-check.mjs [cx] [cz] [texId]
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';
import { WorldService } from '../server/world-service.mjs';

const [cxArg, czArg, texWant] = process.argv.slice(2);
const cx = +(cxArg ?? 51), cz = +(czArg ?? 51);
const wantTex = texWant ?? 'minecraft:block/water_still';

import { openBatch } from '../web/js/payload.js';
import { buildStateIds } from '../server/chunk-payload.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null);

const raw = svc.batchBytes('minecraft:overworld', cx - 1, cz - 1, 3, 3);
const chunks = openBatch(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).filter(Boolean);

const cell = assets.textures.find((t) => t.id === wantTex);
if (!cell) {
  console.log(`no texture ${wantTex}; translucent ids:`,
    assets.textures.filter((t) => t.kind === 2).slice(0, 12).map((t) => t.id).join(', '));
  process.exit(1);
}
const at = (ccx, ccz, lx, ly, lz) => {
  const c = chunks.find((c) => c.cx === ccx && c.cz === ccz);
  if (!c) return null;
  const id = c.stateAt(lx & 15, ly, lz & 15);
  return id ? id - 1 : null;
};
const { streams, stats } = meshChunk(assets, chunks.find((c) => c.cx === cx && c.cz === cz), at, {});
const inCell = (u, v) => u >= cell.u0 - 1e-4 && u <= cell.u1 + 1e-4 && v >= cell.v0 - 1e-4 && v <= cell.v1 + 1e-4;
const counts = streams.map((s) => {
  let n = 0;
  for (let i = 0; i + 5 < s.uv.length; i += 6) {
    // triangles are emitted as 3 consecutive vertices
    if (inCell(s.uv[i], s.uv[i + 1]) && inCell(s.uv[i + 2], s.uv[i + 3]) && inCell(s.uv[i + 4], s.uv[i + 5])) n++;
  }
  return n;
});
// how much water is in this chunk at all, and how many of its faces should be visible
const c0 = chunks.find((c) => c.cx === cx && c.cz === cz);
let water = 0, exposed = 0;
const wIdx = assets.stateIndex.get('minecraft:water|level=0');
for (let y = c0.yMin; y < c0.yMin + c0.yCount; y++)
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    if (c0.stateAt(x, y, z) !== wIdx + 1) continue;
    water++;
    let any = false;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nb = at(cx, cz, x + dx, y + dy, z + dz);
      if (nb !== wIdx && (nb == null || assets.stateOpaque[nb] !== 1)) any = true;
    }
    if (any) exposed++;
  }
console.log({ chunk: [cx, cz], cell, stats }, '\ntriangles sampling', wantTex, 'per pass:', counts,
  '\nwater blocks:', water, 'water blocks with a visible face:', exposed,
  '\nchunk stream verts:', streams.map((s) => s.count));
