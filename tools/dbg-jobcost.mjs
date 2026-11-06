// What does ONE detail mesh job cost, and in which pocket?
//
//   node tools/dbg-jobcost.mjs [--chunks 12] [--dim minecraft:overworld]
//
// The browser pays three separate bills for every chunk it meshes:
//   1. main thread: build the worker message - up to 9 chunks' voxels and light, structured-cloned
//      by postMessage;
//   2. worker: the mesher itself;
//   3. main thread: turn the returned streams into BufferGeometry and upload.
// `meshMs` in the HUD mixes 1+2 (round trip), so this separates them. 9.6 (mesh once per payload)
// only helps if a whole job is being paid more than once; this says what one job is worth.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { stateIndexAt, lightLevelAt, skyLevelAt, sectionIndex } from '../web/js/lookup.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const N = +arg('chunks', 12);
const DIM = arg('dim', 'minecraft:overworld');

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
const rx0 = meta.regionExtent.minX, rx1 = meta.regionExtent.maxX;
const rz0 = meta.regionExtent.minZ, rz1 = meta.regionExtent.maxZ;

// Same as main.js plainChunk: the typed arrays travel by value across the worker boundary.
const plainChunk = (c) => ({
  cx: c.cx, cz: c.cz, yMin: c.yMin, yCount: c.yCount, palette: c.palette, height: c.height,
  sections: c.sections.map((s) => ({
    y: s.y, single: s.single, vox: s.vox, sky: s.sky, blk: s.blk, skyArr: s.skyArr, blkArr: s.blkArr,
  })),
});
const bl = (x) => (x && x.byteLength) || 0;
const bytesOf = (msg) => msg.reduce((a, c) => a + bl(c.palette) + bl(c.height)
  + c.sections.reduce((b, s) => b + bl(s.vox) + bl(s.skyArr) + bl(s.blkArr), 0), 0);

const t = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const acc = { send: 0, clone: 0, mesh: 0, build: 0, msgBytes: 0, verts: 0, n: 0, neigh: 0 };
let tries = 0;
while (acc.n < N && tries++ < N * 40) {
  const cx = (rx0 + Math.floor(Math.random() * (rx1 - rx0 + 1))) * 32 + Math.floor(Math.random() * 28);
  const cz = (rz0 + Math.floor(Math.random() * (rz1 - rz0 + 1))) * 32 + Math.floor(Math.random() * 28);
  const store = new Map();
  let ok = true;
  for (let dz = -1; dz <= 1 && ok; dz++) for (let dx = -1; dx <= 1; dx++) {
    const b = svc.chunkBytes(DIM, cx + dx, cz + dz);
    if (!b) { ok = false; break; }
    store.set(`${cx + dx},${cz + dz}`, openChunk(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  }
  if (!ok) continue;
  const get = (a, b) => store.get(`${a},${b}`);
  const map = new Map();
  for (const [k, ch] of store) map.set(k, { ch, secOf: sectionIndex(ch) });
  const getCh = (a, b) => map.get(`${a},${b}`);

  let t0 = t();
  const msg = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = get(cx + dx, cz + dz);
    if (c) msg.push(plainChunk(c));
  }
  let t1 = t();
  acc.clone += t1 - t0;
  acc.msgBytes += bytesOf(msg);
  acc.neigh += msg.length;
  const cloned = structuredClone(msg);        // what postMessage does to the main thread
  t0 = t(); acc.clone += t0 - t1;

  const at = (a, b, lx, ly, lz) => stateIndexAt(getCh, a, b, lx, ly, lz, assets.states.length);
  const opts = { lightOn: 1, skyScale: 1, darkcut: 0, buried: 4, buriedSky: 2, ao: true, aoMin: 0.42, aoFar: 0.949, darkFloor: 0.32, darkGamma: 0.72 };
  opts.light = (a, b, lx, ly, lz) => lightLevelAt(getCh, a, b, lx, ly, lz, 1);
  opts.sky = (a, b, lx, ly, lz) => skyLevelAt(getCh, a, b, lx, ly, lz);
  t0 = t();
  const r = meshChunk(assets, get(cx, cz), at, opts);
  t1 = t();
  acc.mesh += t1 - t0;
  const st = r.streams.filter((s) => s.count);
  acc.build += 0;                              // streams arrive trimmed; the rest is GPU upload
  acc.verts += st.reduce((a, s) => a + s.count, 0);
  acc.n++;
}

const per = (x) => (x / acc.n).toFixed(2);
console.log(`${DIM}: ${acc.n} mesh jobs, ${acc.n ? (acc.neigh / acc.n).toFixed(1) : 0} chunks per message`);
console.log(`  message            ${per(acc.msgBytes / 1024)} KB of typed arrays cloned per job`);
console.log(`  main: build+clone  ${per(acc.clone)} ms`);
console.log(`  worker: meshChunk  ${per(acc.mesh)} ms`);
console.log(`  verts              ${per(acc.verts)} (${per(acc.verts * 16 / 1024)} KB of streams)`);
console.log(`  job total          ${per(acc.clone + acc.mesh)} ms of CPU (build+clone + mesher)`);
console.log(`\n  a pan that crosses R chunks per second wants ${per(acc.clone + acc.mesh)} ms of CPU x R,`);
console.log(`  and ${per(acc.msgBytes / 1024)} KB x R of it is neighbour bytes, not the chunk being meshed.`);
