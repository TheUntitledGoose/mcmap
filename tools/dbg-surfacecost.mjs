// What would it cost to bake the detail layer instead of meshing it in the browser?
//
//   node tools/dbg-surfacecost.mjs [--chunks 48] [--dim minecraft:overworld] [--present 284239]
//
// It decodes a sample of real chunks and runs the browser's own detail mesher over the middle one of
// a 3x3 block (a chunk meshed alone would look cheaper than it is) three times, with the three
// settings that matter:
//
//   as live   - what the viewer draws today: unlit rock hidden, cave mouths kept
//   caves     - every face including the underground: the worst case a bake could store
//   skin      - `surfaceOnly`: a face whose air cell has rock above it is not a surface, gone
//
// A stream is 16 bytes per vertex (pos f32x3, col u8x3, page u8) and the mesher writes *unindexed*
// triangles, 6 vertices per face, so the size of a chunk's geometry is simply verts x 16. The extrapolation is per present chunk, so pass the save's real count rather
// than trusting an extent that includes 400k empty slots.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk, NEIGH_COVERED } from '../web/js/mesher.js';
import { stateIndexAt, lightLevelAt, skyLevelAt, sectionIndex } from '../web/js/lookup.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const N = +arg('chunks', 48);
const DIM = arg('dim', 'minecraft:overworld');
const PRESENT = +arg('present', 284239);     // build/census.json, overworld

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geoBuf = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geoBuf.buffer.slice(geoBuf.byteOffset, geoBuf.byteOffset + geoBuf.byteLength));
const stateIds = buildStateIds(atlas.states.map((s) => s.k));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', stateIds, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
  isFilmState: (id) => cls.film[id - 1] === 1,
});
const meta = svc.dimList().find((d) => d.id === DIM || d.key === DIM);
const hasSky = svc.dimHasSky(DIM);
console.log(`${DIM}: extent ${(meta.chunkExtent.maxX - meta.chunkExtent.minX + 1)}x${meta.chunkExtent.maxZ - meta.chunkExtent.minZ + 1}`
  + `, ${meta.regions} regions, upper bound ${meta.chunksUpperBound}, priced at ${PRESENT} present chunks`);

const sum = {};
for (const k of ['live', 'caves', 'skin']) sum[k] = { v: 0, q: 0, ms: 0, dark: 0, faces: 0 };
let samples = 0, payload = 0;
// Sample either at random over the save (a whole-world mean) or at named chunk coords (--spots),
// which is how to price the part of the map people actually look at.
const SPOTS = (arg('spots', '')).split(/\s+/).filter(Boolean).map((s) => s.split(',').map(Number));
const rx0 = meta.regionExtent.minX, rx1 = meta.regionExtent.maxX;
const rz0 = meta.regionExtent.minZ, rz1 = meta.regionExtent.maxZ;
for (let tries = 0; samples < N && tries < N * 40; tries++) {
  const spot = SPOTS[tries % SPOTS.length];
  const cx = spot ? spot[0] + ((tries * 7) % 24) : (rx0 + Math.floor(Math.random() * (rx1 - rx0 + 1))) * 32 + Math.floor(Math.random() * 28);
  const cz = spot ? spot[1] + ((tries * 11) % 24) : (rz0 + Math.floor(Math.random() * (rz1 - rz0 + 1))) * 32 + Math.floor(Math.random() * 28);
  const store = new Map();
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const b = svc.chunkBytes(DIM, cx + dx, cz + dz);
    if (!b) continue;
    payload += b.length;
    // The server hands back a Node Buffer; the browser reader wants a standalone ArrayBuffer.
    store.set(`${cx + dx},${cz + dz}`, openChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  }
  const chunk = store.get(`${cx},${cz}`);
  if (!chunk) continue;                       // an unloaded slot prices nothing
  samples++;
  const secOf = sectionIndex(chunk);
  const map = new Map();
  for (const [k, ch] of store) map.set(k, { ch, secOf: sectionIndex(ch) });
  const getCh = (a, b) => map.get(`${a},${b}`);
  // Exactly the accessors web/js/mesh-worker.js builds, so these numbers are the numbers the browser
  // pays and not the numbers a friendlier harness would like to pay.
  const at = (ccx, ccz, lx, ly, lz) => stateIndexAt(getCh, ccx, ccz, lx, ly, lz, assets.states.length);
  const base = { ao: true, aoMin: 0.42, darkFloor: 0.32, darkGamma: 0.72, skyScale: 1, lightOn: hasSky ? 1 : 0 };
  for (const [name, cfg] of [
    ['live', { ...base, darkcut: 0, buried: 4, buriedSky: 2 }],
    ['caves', { ...base, darkcut: -1, buried: 0 }],
    ['skin', { ...base, darkcut: 0, buried: 4, buriedSky: 2, surfaceOnly: 1 }],
  ]) {
    const opts = { ...cfg };
    if (opts.lightOn) {
      opts.light = (a, b, lx, ly, lz) => lightLevelAt(getCh, a, b, lx, ly, lz, opts.skyScale ?? 1);
      opts.sky = (a, b, lx, ly, lz) => skyLevelAt(getCh, a, b, lx, ly, lz);
    } else delete opts.sky;
    const t = process.hrtime.bigint();
    const r = meshChunk(assets, chunk, at, opts);
    sum[name].ms += Number(process.hrtime.bigint() - t) / 1e6;
    // Vertex count lives on the streams; stats counts quads and the culls, and both matter here.
    sum[name].v += r.streams.reduce((a, s) => a + s.count, 0);
    sum[name].q += r.stats.quads;
    sum[name].dark += r.stats.darkCulled + r.stats.buried;
    sum[name].faces += r.stats.faces;
  }
}
console.log(`\nsampled ${samples} chunks, mean payload ${(payload / (samples * 9) / 1024).toFixed(1)} KB`);
const per = {};
for (const [k, x] of Object.entries(sum)) {
  per[k] = { v: x.v / samples, q: x.q / samples, ms: x.ms / samples, dark: x.dark / samples, faces: x.faces / samples };
  console.log(`  ${k.padEnd(5)} ${Math.round(per[k].v).toString().padStart(7)} verts `
    + `${Math.round(per[k].q).toString().padStart(6)} quads  ${per[k].ms.toFixed(1).padStart(6)} ms/chunk `
    + ` faces ${Math.round(per[k].faces).toString().padStart(6)} culled-to-air/rock ${Math.round(per[k].dark).toString().padStart(6)}`);
}
console.log(`\nwhole-world bake of ${PRESENT.toLocaleString()} chunks:`);
for (const k of Object.keys(per)) {
  const verts = per[k].v * PRESENT;
  const gb = (verts * 16) / 1e9;
  console.log(`  ${k.padEnd(5)} ${(verts / 1e6).toFixed(1).padStart(7)} M verts, `
    + `${gb.toFixed(2).padStart(6)} GB of streams, ${(per[k].ms * PRESENT / 3600000).toFixed(1).padStart(5)} h single-threaded, `
    + `${Math.round(per[k].v * 16 / 1024).toString().padStart(5)} KB/chunk`);
}
const skin = per.skin, live = per.live;
console.log(`\nskin versus live: ${((skin.v / live.v - 1) * 100).toFixed(1)}% verts, `
  + `${((skin.ms / live.ms - 1) * 100).toFixed(1)}% mesh time`);
console.log(`payload today ${(payload / (samples * 9) * PRESENT / 1e9).toFixed(2)} GB of voxel data `
  + `(that is what build/cache holds, and what the browser meshes)`);
