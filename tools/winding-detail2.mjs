import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null);
const chunk = openChunk(ab(svc.chunkBytes('minecraft:overworld', 3, 3)));
const halo = new Map();
for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
  const b = svc.chunkBytes('minecraft:overworld', 3 + dx, 3 + dz);
  if (b) halo.set(`${3 + dx},${3 + dz}`, openChunk(ab(b)));
}
const at = (ccx, ccz, lx, ly, lz) => {
  const c = halo.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);
  if (!c) return -1;
  const s = c.sectionAt(ly);
  if (!s) return -1;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
  return id === 0 ? -1 : id - 1;
};
const { streams } = meshChunk(assets, chunk, at);
const opaque = (wx, wy, wz) => { const id = at(0, 0, wx, wy, wz); return id >= 0 && assets.stateOpaque[id] === 1; };
for (let pass = 0; pass < 3; pass++) {
  const st = streams[pass];
  for (let q = 0; q < st.count; q += 6) {
    const p = [0, 1, 2, 3].map((k) => [st.position[(q + k) * 3], st.position[(q + k) * 3 + 1], st.position[(q + k) * 3 + 2]]);
    const u = p[1].map((v, i) => v - p[0][i]), w = p[2].map((v, i) => v - p[0][i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const ax = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
    if (Math.abs(n[ax]) < 1e-9) continue;
    const c = [0, 1, 2].map((i) => (p[0][i] + p[2][i]) / 2);
    const off = [0, 0, 0]; off[ax] = n[ax] > 0 ? 0.5 : -0.5;
    const F = [Math.floor(c[0] + off[0]), Math.floor(c[1] + off[1]), Math.floor(c[2] + off[2])];
    const B = [Math.floor(c[0] - off[0]), Math.floor(c[1] - off[1]), Math.floor(c[2] - off[2])];
    if (opaque(F[0], F[1], F[2]) && !opaque(B[0], B[1], B[2])) {
      const key = (v) => { const id = at(0, 0, v[0], v[1], v[2]); return id < 0 ? 'unknown' : atlas.states[id].k; };
      console.log(`pass ${pass} at ${F} front=${key(F)} back=${key(B)} normal=${n.map((x) => Math.round(x)).join(',')}`);
    }
  }
}
