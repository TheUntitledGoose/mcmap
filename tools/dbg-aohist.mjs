// M6 step 0: what ambient occlusion actually does to real chunks, as a distribution rather than a
// mean. `?ao=0.42` (the AO floor) was picked by eye; the honest question is how many vertices sit at
// the floor, and how much darker the darkest 1% of a scene is than its average. That decides both the
// default and whether a floor change is even visible.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';

const DIM = process.env.DIM || 'minecraft:overworld';
const AOMIN = +(process.env.AOMIN || 0.42);
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
const at = (cx, cz, lx, ly, lz) => {
  const c = chunkAt(cx + (lx >> 4), cz + (lz >> 4));
  if (!c) return -1;
  const s = c.sectionAt(ly);
  if (!s) return -1;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
  return id ? id - 1 : -1;
};

// Sample every 8th chunk over a square, so the answer is terrain and not a hand-picked view.
const want = [];
for (let cz = -24; cz <= 24; cz += 8) for (let cx = -24; cx <= 24; cx += 8) want.push([cx, cz]);
const samples = (process.env.CHUNKS ? +process.env.CHUNKS : 48);

const ratios = [];
const perChunk = [];
let chunks = 0;
for (const [cx, cz] of want) {
  if (chunks >= samples) break;
  if (!svc.chunkBytes(DIM, cx, cz)) continue;
  const chunk = chunkAt(cx, cz);
  const run = (ao) => {
    const { streams } = meshChunk(assets, chunk, at, { ao, aoMin: AOMIN });
    const out = [];
    for (const s of streams) if (s.color) out.push(s.color);
    return out;
  };
  const on = run(true), off = run(false);
  if (!on.length || !off.length) continue;
  chunks++;
  let n = 0, sum = 0, atFloor = 0, dark = 0;
  for (let a = 0; a < on.length; a++) {
    const A = on[a], B = off[a];
    const m = Math.min(A.length, B.length);
    for (let i = 0; i < m; i += 3) {
      // Only the AO differs between the two meshes, so the mean channel ratio is that vertex's
      // occlusion. A sprite tint or face shade cancels out.
      const r = (A[i] / B[i] + A[i + 1] / B[i + 1] + A[i + 2] / B[i + 2]) / 3;
      if (!Number.isFinite(r) || B[i] === 0) continue;
      ratios.push(r); n++; sum += r;
      if (r <= AOMIN + 1e-3) atFloor++;
      if (r < 0.5) dark++;
    }
  }
  if (n) perChunk.push(`${cx},${cz} ${n}v mean ${(sum / n).toFixed(3)} floor% ${(100 * atFloor / n).toFixed(1)} under0.5% ${(100 * dark / n).toFixed(1)}`);
}

ratios.sort((a, b) => a - b);
const pct = (p) => +ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))].toFixed(3);
const hist = {};
for (const r of ratios) {
  const b = Math.min(10, Math.max(0, Math.floor(r * 10)));
  hist[`${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`] = (hist[`${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`] || 0) + 1;
}
const n = ratios.length;
console.log(JSON.stringify({
  dim: DIM, aoMin: AOMIN, chunks, verts: n,
  mean: +(ratios.reduce((a, v) => a + v, 0) / n).toFixed(4),
  p0: pct(0), p1: pct(0.01), p5: pct(0.05), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p95: pct(0.95), p100: pct(1),
  atFloorPct: +(100 * ratios.filter((r) => r <= AOMIN + 1e-3).length / n).toFixed(2),
  underHalfPct: +(100 * ratios.filter((r) => r < 0.5).length / n).toFixed(2),
  hist,
  perChunk: perChunk.slice(0, 6),
}, null, 1));
