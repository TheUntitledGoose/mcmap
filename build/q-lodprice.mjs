// Price the pre-baked coarse tiers: real chunks, real mesher, real bytes.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { shellFromPayload } from '../server/shell.mjs';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch, meshOverview } from '../web/js/shell-mesh.js';
import { meshChunk } from '../web/js/mesher.js';
import { Assets } from '../web/js/assets.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
});
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

// A spread of populated overworld chunks, taken where terrain is built up.
const SAMPLE = [];
for (const cx of [0, 3, 8, 14, 40, 97, 150, 200, -5, -40, -120, -200]) {
  for (const cz of [0, 5, 11, 30, 60, -3, -30, -77]) {
    const b = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (b) SAMPLE.push([cx, cz, b]);
  }
}
const shellOf = new Map();
for (const [cx, cz, b] of SAMPLE) {
  const fr = shellFromPayload(b, { isPaint: svc.isPaintState, isSolid: svc.isSolidState, hasSky: true });
  if (fr) shellOf.set(`${cx},${cz}`, openShellFrame(ab(fr)));
}
console.log('chunks with payload', SAMPLE.length, 'chunks with a shell', shellOf.size);
const get = (cx, cz) => shellOf.get(`${cx},${cz}`) ?? null;

const bytesOf = (s) => s.position.byteLength + s.uv.byteLength + s.color.byteLength;
const compOf = (s) => zlib.deflateSync(Buffer.from(s.position.buffer)).length
  + zlib.deflateSync(Buffer.from(s.uv.buffer)).length
  + zlib.deflateSync(Buffer.from(s.color.buffer)).length;

const rows = [];
for (const cell of [1, 2, 4, 8, 16]) {
  let verts = 0, raw = 0, comp = 0, cols = 0, walls = 0;
  for (const [cx, cz] of SAMPLE) {
    const { stream, stats } = meshShellPatch(assets, get, cx, cz, 1, 1, { cell, maxSkirt: 32, trackStates: false });
    if (!stream.count) continue;
    verts += stream.count; raw += bytesOf(stream); comp += compOf(stream);
    cols += stats.columns; walls += stats.walls;
  }
  rows.push({ cell, blkPerCol: cell, verts: +(verts / SAMPLE.length).toFixed(0),
    rawB: +(raw / SAMPLE.length).toFixed(0), compB: +(comp / SAMPLE.length).toFixed(0),
    cols: +(cols / SAMPLE.length).toFixed(1), walls: +(walls / SAMPLE.length).toFixed(1) });
}
// full voxel detail, for the same chunks
let dv = 0, draw = 0, dcomp = 0, n = 0;
for (const [cx, cz, b] of SAMPLE) {
  const c = (await import('../server/chunk-payload.mjs')).openChunk(b);
  const st = meshChunk(assets, c, () => 0, { ao: true });
  for (const pass of [0, 1, 2]) {
    const s = st[pass];
    if (!s || !s.count) continue;
    dv += s.count; draw += bytesOf(s); dcomp += compOf(s);
  }
  n++;
}
rows.push({ cell: 0, blkPerCol: 'voxel', verts: +(dv / n).toFixed(0), rawB: +(draw / n).toFixed(0),
  compB: +(dcomp / n).toFixed(0) });
const PRESENT = 284239;
console.log(JSON.stringify({ chunks: SAMPLE.length, present: PRESENT, rows: rows.map((r) => ({
  ...r, gbWorld: r.compB ? +((r.compB * PRESENT) / 1e9).toFixed(2) : 0,
  vertsWorld: r.verts ? +((r.verts * PRESENT) / 1e9).toFixed(2) : 0,
})), bytesPerVert: bytesOf(meshShellPatch(assets, get, SAMPLE[0][0], SAMPLE[0][1], 1, 1, { cell: 4 }).stream) / 1 }, null, 1));
