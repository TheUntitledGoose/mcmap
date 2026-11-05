// How much darker is the near (voxel) layer than the far (shell) layer, by construction?
// The detail pass multiplies every vertex by ambient occlusion; the shell has none. This measures the
// real ratio on real chunks so the far layer can be matched with a number instead of an eyeball.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';

const DIM = 'minecraft:overworld';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});

const open = new Map();
const chunkAt = (cx, cz) => {
  const k = `${cx},${cz}`;
  if (!open.has(k)) open.set(k, (() => { const b = svc.chunkBytes(DIM, cx, cz); return b ? openChunk(b) : null; })());
  return open.get(k);
};
// Same shape as ChunkStore.stateIndexAt: chunk coords plus *local* (possibly out-of-chunk) coords.
const at = (cx, cz, lx, ly, lz) => {
  const c = chunkAt(cx + (lx >> 4), cz + (lz >> 4));
  if (!c) return -1;
  const s = c.sectionAt(ly);
  if (!s) return -1;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
  return id ? id - 1 : -1;
};

const per = [];
for (const [cx, cz] of [[0, 0], [3, 3], [-5, 7], [40, 40], [120, -30], [186, 125], [186, 124], [-40, -40], [60, 60], [-8, -8], [100, 100], [-100, 40]]) {
  if (!svc.chunkBytes(DIM, cx, cz)) continue;
  const chunk = chunkAt(cx, cz);
  const run = (ao) => {
    const { streams } = meshChunk(assets, chunk, at, { ao, aoMin: 0.42 });
    let n = 0;
    const sum = [0, 0, 0];
    for (const s of streams) {
      const c = s.color;
      if (!c) continue;
      for (let i = 0; i < c.length; i += 3) { sum[0] += c[i]; sum[1] += c[i + 1]; sum[2] += c[i + 2]; n++; }
    }
    return n ? { n, mean: sum.map((v) => v / n) } : null;
  };
  const on = run(true), off = run(false);
  if (on && off) per.push({ k: `${cx},${cz}`, verts: on.n, ratio: on.mean.map((v, i) => v / off.mean[i]) });
}

const tot = { n: 0, on: [0, 0, 0], off: [0, 0, 0] };
for (const p of per) { tot.n += p.verts; for (let k = 0; k < 3; k++) tot.on[k] += p.ratio[k] * p.verts; }
console.log(JSON.stringify({
  chunks: per.length, verts: tot.n,
  aoFactor: tot.on.map((v) => +(v / tot.n).toFixed(3)),
  spread: per.map((p) => `${p.k} ${p.verts}v ${p.ratio.map((r) => r.toFixed(3)).join('/')}`),
}, null, 1));
