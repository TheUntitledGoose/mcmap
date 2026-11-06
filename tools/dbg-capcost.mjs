// What the surface caps cost, measured. Two numbers, because the argument is always "is it worth it":
// how many columns actually carry a skin thick enough to draw, and what that adds to a real far patch
// in vertices and milliseconds. Run after node server/bake-shells.mjs, since the skin byte lives in the
// packs.
//
//   node tools/dbg-capcost.mjs [--cell 16] [--patches 6] [--dim minecraft:overworld]
import fs from 'node:fs';
import path from 'node:path';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { atlasStamp } from '../server/shell-pack.mjs';
import { Assets } from '../web/js/assets.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { openShellFrame } from '../web/js/payload.js';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const DIM = arg('dim', 'minecraft:overworld');
const CELL = +arg('cell', 16);
const PATCH = +arg('patch', 16);
const N = +arg('patches', 6);
const CAPDROP = +arg('capdrop', 4);
const SHOW = +arg('show', 6);

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

// Where the columns with skin are, and how thick it gets. Sampled straight out of the packs, because
// the pack is what the browser reads.
const spots = String(arg('spots', '0,0 54,63 2976,2007 -40,-120 900,900 -900,-900')).split(/\s+/)
  .map((s) => s.split(',').map(Number));
let cols = 0, skinned = 0, thick = 0, maxBand = 0;
const thickest = [];
const hist = new Map();
for (const [wx, wz] of spots) {
  for (let dx = 0; dx < 8; dx++) {
    for (let dz = 0; dz < 8; dz++) {
      const f = svc.shellBytes(DIM, (wx >> 4) + dx, (wz >> 4) + dz);
      if (!f) continue;
      const sh = openShellFrame(f.buffer ? f.buffer.slice(f.byteOffset, f.byteOffset + f.length) : f);
      for (let i = 0; i < 256; i++) {
        cols++;
        const b = sh.band[i];
        if (b) { skinned++; hist.set(b, (hist.get(b) ?? 0) + 1); }
        if (b >= CAPDROP) thick++;
        if (b > maxBand) maxBand = b;
        // The thickest skins are the interesting ones: either a canopy with air under it, or a hillside
        // whose surface block the paint rule refuses. Both need looking at, not averaging.
        if (SHOW && b >= 12) {
          const k = thickest.length;
          thickest.push({ b, y: sh.height[i] - HEIGHT_BIAS, g: sh.ground[i] - HEIGHT_BIAS,
            cover: atlas.states[sh.cover[i] - 1]?.k, paint: atlas.states[sh.state[i] - 1]?.k,
            cx: sh.cx, cz: sh.cz, i });
          if (thickest.length > SHOW) thickest.sort((p, q) => q.b - p.b), thickest.length = SHOW;
        }
      }
    }
  }
}
console.log(`columns sampled ${cols}`);
console.log(`with a skin ${skinned} (${(100 * skinned / cols).toFixed(1)}%), thick enough (>=${CAPDROP}) ${thick} (${(100 * thick / cols).toFixed(1)}%), thickest ${maxBand}`);
console.log(`skin thickness histogram ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}:${n}`).join(' ')}`);
for (const t of thickest.sort((a, b) => b.b - a.b)) {
  console.log(`thick skin ${t.b}: chunk ${t.cx},${t.cz} col ${t.i & 15},${t.i >> 4} surface y=${t.y} ground=${t.g} cover=${t.cover} paint=${t.paint}`);
}

// The same patches cut with and without caps: verts and milliseconds, side by side.
const shellAt = (cx, cz) => {
  const f = svc.shellBytes(DIM, cx, cz);
  if (!f) return null;
  return openShellFrame(f.buffer ? f.buffer.slice(f.byteOffset, f.byteOffset + f.length) : f);
};
let vOff = 0, vOn = 0, caps = 0, msOff = 0, msOn = 0, did = 0;
for (const [wx, wz] of spots) {
  const cx0 = Math.floor(wx / 16), cz0 = Math.floor(wz / 16);
  const opts = {
    cell: CELL, maxSkirt: 24, blend: 1, cap: 1 << 20, groundFar: 1, waterOpacity: 0.72,
    aoFar: 0.949, lightOn: true, darkFloor: 0.32, darkGamma: 0.72, skyScale: 1, capDrop: CAPDROP,
  };
  const a = (() => { const t = performance.now(); const r = meshShellPatch(assets, shellAt, cx0, cz0, PATCH, PATCH, { ...opts, caps: 0 }); r.ms = performance.now() - t; return r; })();
  const b = (() => { const t = performance.now(); const r = meshShellPatch(assets, shellAt, cx0, cz0, PATCH, PATCH, { ...opts, caps: 1 }); r.ms = performance.now() - t; return r; })();
  if (!a.stream.count || !b.stream.count) { console.log(`spot ${wx},${wz}: nothing meshed (packs missing?)`); continue; }
  did++;
  vOff += a.stream.count; vOn += b.stream.count; caps += b.stats.caps || 0;
  msOff += a.ms; msOn += b.ms;
  console.log(`patch ${cx0},${cz0} cell ${CELL}: verts ${a.stream.count} -> ${b.stream.count} `
    + `(+${(100 * (b.stream.count - a.stream.count) / a.stream.count).toFixed(1)}%) `
    + `caps ${b.stats.caps} walls ${b.stats.capWalls}  ms ${a.ms.toFixed(1)} -> ${b.ms.toFixed(1)}`);
}
if (did) {
  console.log(`TOTAL ${did} patches at cell ${CELL}: verts ${(vOff / 1e6).toFixed(2)}M -> ${(vOn / 1e6).toFixed(2)}M `
    + `(+${(100 * (vOn - vOff) / vOff).toFixed(1)}%), caps ${caps}, ms ${msOff.toFixed(0)} -> ${msOn.toFixed(0)} `
    + `(+${(100 * (msOn - msOff) / msOff).toFixed(1)}%)`);
}
svc.close?.();
