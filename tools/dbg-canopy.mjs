// How far the coarse far view is floating above the ground it is painted with.
//
// A shell column stores one height (WORLD_SURFACE: leaves, plants, everything visible) and one
// state (the block the surface is made of). Where a canopy sits on ground, the height is the
// treetops and the colour comes from the leaves - so the far view draws a flat table at canopy
// height with a cliff wall down to the ground. This measures exactly that gap over real chunks,
// so the fix can be sized instead of guessed at.
//
//   node tools/dbg-canopy.mjs [--cx -8] [--cz -8] [--w 24] [--dim minecraft:overworld] [--drop 40]
import { readFileSync } from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS, SHELL_COLS } from '../shared/chunk-format.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const atlas = JSON.parse(readFileSync(arg('assets', 'build/assets') + '/atlas.json', 'utf8'));
const stateIds = buildStateIds(atlas.states.map((s) => s.k));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService(arg('world', 'DarkRPG/world'), stateIds, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});
const dim = arg('dim', 'minecraft:overworld');
const cx0 = +arg('cx', -8), cz0 = +arg('cz', -8), w = +arg('w', 24);
const drop = +arg('drop', 40);
const isCube = (id) => cls.cube[id - 1] === 1;

const hist = new Map();
let cols = 0, gapped = 0, gapSum = 0, maxGap = 0, cubeTop = 0, noCube = 0;
const worst = [];
for (let cz = cz0; cz < cz0 + w; cz++) {
  for (let cx = cx0; cx < cx0 + w; cx++) {
    const bytes = svc.chunkBytes(dim, cx, cz);
    if (!bytes || !bytes.length) continue;
    const c = openChunk(bytes);
    if (!c.height) continue;
    for (let i = 0; i < SHELL_COLS; i++) {
      const x = i & 15, z = i >> 4;
      const top = c.height[i] - HEIGHT_BIAS;
      const surf = c.stateAt(x, top, z);
      if (surf && isCube(surf)) { cubeTop++; hist.set(0, (hist.get(0) ?? 0) + 1); cols++; continue; }
      let found = -1;
      for (let k = 1; k <= drop; k++) {
        const b = c.stateAt(x, top - k, z);
        if (b && isCube(b)) { found = k; break; }
      }
      cols++;
      if (found < 0) { noCube++; continue; }
      gapped++; gapSum += found;
      if (found > maxGap) { maxGap = found; worst.push([cx, cz, x, z, top, surf && atlas.states[surf - 1].k]); }
      const bucket = found <= 2 ? '1-2' : found <= 5 ? '3-5' : found <= 10 ? '6-10'
        : found <= 20 ? '11-20' : found <= 40 ? '21-40' : '41+';
      hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
    }
  }
}

const order = ['0', '1-2', '3-5', '6-10', '11-20', '21-40', '41+'];
console.log(`columns sampled: ${cols}`);
console.log(`surface is already a full cube: ${cubeTop} (${(100 * cubeTop / cols).toFixed(1)}%)`);
console.log(`no full cube within ${drop} blocks: ${noCube} (${(100 * noCube / cols).toFixed(1)}%)`);
console.log(`canopy above ground: ${gapped} (${(100 * gapped / cols).toFixed(1)}%), `
  + `mean gap ${(gapSum / Math.max(1, gapped)).toFixed(1)} blocks, max ${maxGap}`);
for (const b of order) {
  const n = hist.get(b) ?? 0;
  console.log(`  gap ${b.padEnd(6)} ${String(n).padStart(7)}  ${(100 * n / cols).toFixed(1)}%  ${'#'.repeat(Math.round(60 * n / cols))}`);
}
console.log('deepest gaps (chunk, local x/z, surface y, surface state):');
for (const wv of worst.slice(-6)) console.log('  ', wv.join(' '));
