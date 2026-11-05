// How many vertices does a shell patch cost, and how small can it get?
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { Assets } from '../web/js/assets.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), 'build/cache',
  { isCubeState: (id) => cls.cube[id - 1] === 1 });
const cache = new Map();
const get = (cx, cz) => {
  const k = cx + ',' + cz;
  if (!cache.has(k)) { const b = svc.shellBytes('minecraft:overworld', cx, cz); cache.set(k, b ? openShellFrame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null); }
  return cache.get(k);
};
const assets = new Assets(atlas, fs.readFileSync('build/assets/geometry.bin').buffer.slice(0));
const N = +(process.argv[2] || 16);
const t0 = performance.now();
const { stream, stats } = meshShellPatch(assets, get, 0, 0, N, N, { cell: +process.argv[3] || 1 });
const ms = performance.now() - t0;
const verts = [stream.count], quads = verts.reduce((a, b) => a + b, 0) / 4;
console.log(`patch ${N}x${N} chunks (${N * 16}x${N * 16} blocks): verts ${verts} tris ${verts.reduce((a, b) => a + b, 0) / 2} quads ${quads} in ${ms.toFixed(0)} ms`);
console.log('stats', stats);
console.log(`detail chunks in the same area: ${N * N}, at ~30 ms/chunk mesh = ${N * N * 30 / 1000} s`);
