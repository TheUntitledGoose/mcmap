// M10 pricing: how much of a chunk mesh is geometry no light reaches?
//
// Meshes real chunks (with their eight neighbours held, so light and occlusion resolve like they do
// in the viewer) once with the dark cull off, then at `darkcut` 0 / 2 / 4, and reports what each
// threshold removes. `darkcut` is the highest combined light level a face's *air side* may have and
// still be dropped; -1 is the `?caves=1` path.
import { readFileSync } from 'node:fs';
import { openChunk } from '../web/js/payload.js';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';
import { lightLevelAt, sectionIndex } from '../web/js/lookup.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const geob = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, geob.buffer.slice(geob.byteOffset, geob.byteOffset + geob.length));
const svc = new WorldService('DarkRPG/world', buildStateIds(a.states.map((s) => s.k)), 'build/cache', {});
const DIM = process.env.DIM || 'minecraft:overworld';

const coords = process.argv.slice(2);
if (!coords.length) coords.push('3,3', '2,-3', '-15,-24', '-4,-4', '10,10', '30,-12', '-40,20', '-8,-8');

const buf = (raw) => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
const CUTS = [-1, 0, 2, 4];
const tot = Object.fromEntries(CUTS.map((c) => [c, { faces: 0, verts: 0, ms: 0, dark: 0 }]));
let unknownAir = 0;

for (const cs of coords) {
  const [cx, cz] = cs.split(',').map(Number);
  // Hold the 3x3 neighbourhood: with only the centre chunk loaded, every border face reads as
  // unknown light and is kept by design, which would hide the whole effect.
  const map = new Map();
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const raw = svc.chunkBytes(DIM, cx + dx, cz + dz);
    if (!raw) continue;
    const c = openChunk(buf(raw));
    map.set(`${c.cx},${c.cz}`, { ch: c, secOf: sectionIndex(c) });
  }
  const centre = map.get(`${cx},${cz}`)?.ch;
  if (!centre) { console.log(`${cs} no chunk`); continue; }
  const at = (ccx, ccz, lx, ly, lz) => {
    const e = map.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);
    if (!e) return -1;
    const s = e.secOf(ly);
    if (!s) return -1;
    const id = e.ch.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]];
    return id === 0 ? -1 : id - 1;
  };
  const get = (kx, kz) => map.get(`${kx},${kz}`);
  const row = {};
  for (const darkcut of CUTS) {
    const opts = { ao: true, aoMin: 0.42, darkcut, darkFloor: 0.32, darkGamma: 0.72,
      light: (kx, kz, lx, ly, lz) => lightLevelAt(get, kx, kz, lx, ly, lz, 1) };
    const t0 = performance.now();
    const { streams, stats } = meshChunk(assets, centre, at, opts);
    const ms = performance.now() - t0;
    const verts = streams.reduce((s, x) => s + x.count, 0);
    row[darkcut] = { faces: stats.faces, dark: stats.darkCulled, verts, ms };
    const T = tot[darkcut];
    T.faces += stats.faces; T.verts += verts; T.ms += ms; T.dark += stats.darkCulled;
  }
  const base = row[-1];
  const fmt = (c) => {
    const r = row[c];
    return c < 0 ? `caves  ${String(base.faces).padStart(6)}f ${String(base.verts).padStart(7)}v ${base.ms.toFixed(1).padStart(6)}ms`
      : `cut${String(c).padStart(2)}  ${String(r.faces).padStart(6)}f ${String(r.verts).padStart(7)}v ${r.ms.toFixed(1).padStart(6)}ms` +
        `  -${(100 * (1 - r.verts / (base.verts || 1))).toFixed(1)}%`;
  };
  console.log(`${cs.padEnd(8)} ${CUTS.map(fmt).join('  ')}`);
}

const b = tot[-1];
console.log(`\n${coords.length} chunks  caves: ${b.faces} faces / ${b.verts} verts / ${b.ms.toFixed(0)} ms`);
for (const c of CUTS.filter((x) => x >= 0)) {
  const T = tot[c];
  console.log(`darkcut ${String(c).padStart(2)}: ${T.faces} faces (-${(100 * (1 - T.faces / (b.faces || 1))).toFixed(1)}%)` +
    `  ${T.verts} verts (-${(100 * (1 - T.verts / (b.verts || 1))).toFixed(1)}%)` +
    `  ${T.ms.toFixed(0)} ms (-${(100 * (1 - T.ms / (b.ms || 1))).toFixed(1)}%)  ${(T.ms / coords.length).toFixed(1)} ms/chunk`);
}
