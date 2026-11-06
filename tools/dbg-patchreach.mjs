// How far outside a patch the shell mesher reaches. Moving a patch cut into a worker means sending the
// frames it will read, and that is only affordable if the reach is small and known. Guessing it wrong
// is a hole at the patch border, so this measures it: run a real cut with a spy getter and print the
// bounding box of chunk coordinates it asks for, plus the reach measured in cells.
//
//   node tools/dbg-patchreach.mjs [--cell 16] [--patch 16]
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { atlasStamp } from '../server/shell-pack.mjs';
import { Assets } from '../web/js/assets.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { openShellFrame } from '../web/js/payload.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const DIM = arg('dim', 'minecraft:overworld');
const PATCH = +arg('patch', 16);

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
  packDir: 'build/shells',
  stamp: atlasStamp(fs.statSync('build/assets/atlas.json'), atlas.states.length),
});

const cache = new Map();
const frameAt = (cx, cz) => {
  const k = `${cx},${cz}`;
  if (cache.has(k)) return cache.get(k);
  const f = svc.shellBytes(DIM, cx, cz);
  const sh = f ? openShellFrame(f.buffer.slice(f.byteOffset, f.byteOffset + f.length)) : null;
  cache.set(k, sh);
  return sh;
};

const spots = String(arg('spots', '54,63 2976,2007 -40,-120 900,900')).split(/\s+/)
  .map((s) => s.split(',').map(Number));

for (const cell of [1, 2, 4, 8, 16]) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, asks = 0, hits = 0, verts = 0, ms = 0;
  for (const [wx, wz] of spots) {
    const px = Math.floor((wx >> 4) / PATCH), pz = Math.floor((wz >> 4) / PATCH);
    const x0 = px * PATCH, z0 = pz * PATCH;
    const get = (cx, cz) => {
      asks++;
      if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
      if (cz < minz) minz = cz; if (cz > maxz) maxz = cz;
      const sh = frameAt(cx, cz); if (sh) hits++;
      return sh;
    };
    const t0 = performance.now();
    const { stream } = meshShellPatch(assets, get, x0, z0, PATCH, PATCH, {
      cell, maxSkirt: 3, blend: 0.5, trackStates: true, groundFar: 1, waterOpacity: 0.72,
      aoFar: 0.949, caps: 1, capDrop: 4, capCell: 4, lightOn: 1, darkFloor: 0.32, darkGamma: 0.72,
    });
    ms += performance.now() - t0;
    verts += stream.count;
    const padX = Math.max(x0 - minx, maxx - (x0 + PATCH - 1));
    const padZ = Math.max(z0 - minz, maxz - (z0 + PATCH - 1));
    console.log(`cell ${String(cell).padStart(2)} patch ${px},${pz} verts ${stream.count} pad x ${padX} z ${padZ}`);
  }
  console.log(`cell ${String(cell).padStart(2)}: reach ${minx}..${maxx} x ${minz}..${maxz}, `
    + `${asks} looks, ${hits} found, ${(ms / spots.length).toFixed(1)} ms/cut, ${verts} verts`);
}
