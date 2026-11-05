// what normals does the DETAIL mesher emit? (it shares CUBE rings with the shell mesher)
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { Assets } from '../web/js/assets.js';
import { openBatch } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { quadNormal } from '../shared/faces.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, { isCubeState: (id) => cls.cube[id - 1] === 1 });
const raw = svc.batchBytes('minecraft:overworld', 2, 2, 3, 3);
const chunks = openBatch(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).filter(Boolean);
const map = new Map(chunks.map((c) => [`${c.cx},${c.cz}`, c]));
const stateOf = (id) => (id === 0 || id > assets.states.length ? -1 : id - 1);
const at = (cx, cz, lx, ly, lz) => {
  const c = map.get(`${cx + (lx >> 4)},${cz + (lz >> 4)}`);
  if (!c) return -2;
  const s = c.stateAt(lx & 15, ly, lz & 15);
  return stateOf(s);
};
const { streams } = meshChunk(assets, map.get('3,3'), at, { ao: false });
for (const pass of [0]) {
  const s = streams[pass];
  const pos = s.position;
  const m = new Map();
  for (let q = 0; q < s.count; q += 6) {
    const n = quadNormal(pos.subarray(q * 3, q * 3 + 9));
    const k = n.map((v) => v.toFixed(0)).join(',');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  console.log('pass', pass, [...m.entries()].sort());
}

// Find the quad that covers the top face of one known column, and print its corner order.
const c = map.get('3,3');
const top = c.height[(0 << 4) | 0] - 2048;         // WORLD_SURFACE top block, biased
console.log('column 0,0 top block y =', top, 'state id', c.stateAt(0, top, 0));
const s = streams[0];
for (let q = 0; q < s.count; q += 6) {
  const f = s.position.subarray(q * 3, q * 3 + 9);
  const xs = [f[0], f[3], f[6]], zs = [f[2], f[5], f[8]], ys = [f[1], f[4], f[7]];
  const onTop = ys.every((v) => Math.abs(v - (top + 1)) < 1e-4) &&
    Math.min(...xs) >= 48 - 1e-4 && Math.max(...xs) <= 49 + 1e-4 &&
    Math.min(...zs) >= 48 - 1e-4 && Math.max(...zs) <= 49 + 1e-4;
  if (onTop) console.log('top quad corners', [[f[0], f[1], f[2]], [f[3], f[4], f[5]], [f[6], f[7], f[8]]],
    'normal', quadNormal(f).map((v) => v.toFixed(2)).join(','), 'uv', s.uv.subarray(q * 2, q * 2 + 6).join(','));
}

// print one example of each horizontal-facing quad so the corner order can be compared
const seen = new Set();
for (let q = 0; q < s.count; q += 6) {
  const f = s.position.subarray(q * 3, q * 3 + 9);
  const n = quadNormal(f).map((v) => Math.round(v)).join(',');
  if (n !== '0,1,0' && n !== '0,-1,0') continue;
  if (seen.has(n)) continue;
  seen.add(n);
  console.log('normal', n, 'corners', [[f[0], f[1], f[2]], [f[3], f[4], f[5]], [f[6], f[7], f[8]]],
    'uv', [...s.uv.subarray(q * 2, q * 2 + 6)].map((v) => v.toFixed(3)).join(','));
}
