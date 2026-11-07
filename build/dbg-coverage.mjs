// What the region coverage bitfield actually says about this save, and what a walk over
// inside-the-box-but-unwritten ground costs with and without it.
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const ids = buildStateIds(atlas.states.map((x) => x.k));
const DIM = 'minecraft:overworld';
const s = new WorldService('DarkRPG/world', ids, null, {});
const d = s.resolve(DIM);
console.log('chunkExtent', JSON.stringify(d.chunkExtent), 'region files', d.regions);
const r = s.coverageFor(DIM);
console.log('grid', r.x0, r.z0, `${r.w}x${r.h}`, 'cells set', r.count,
  `= ${(100 * r.count / (r.w * r.h)).toFixed(1)}% of the box`);

// An empty 2x2 region block with ground on either side: inside the bounding box, no files.
let found = null;
for (let rz = r.z0; rz + 1 < r.z0 + r.h && !found; rz++) {
  for (let rx = r.x0; rx + 1 < r.x0 + r.w && !found; rx++) {
    if (!r.has(rx, rz) && !r.has(rx + 1, rz) && !r.has(rx, rz + 1) && !r.has(rx + 1, rz)
      && r.has(rx - 2, rz) && r.has(rx + 3, rz)) found = { rx, rz };
  }
}
console.log('empty 2x2 inside the box at region', JSON.stringify(found));
const cx = found.rx * 32, cz = found.rz * 32;
console.log('hasGround(empty rect) =', s.hasGround(DIM, cx, cz, 64, 64));
console.log('hasGround(neighbouring real ground) =', s.hasGround(DIM, (found.rx - 2) * 32, cz, 64, 64));

// Cost of the same request with the skip and with the walk (coverage forced open).
for (const label of ['coverage on', 'coverage off']) {
  const t = new WorldService('DarkRPG/world', ids, null, { coverageTtlMs: label === 'coverage off' ? -1 : 3e4 });
  if (label === 'coverage off') t.hasGround = () => true;
  const t0 = performance.now();
  const b = await t.shellBatchBytesAsync(DIM, cx, cz, 64, 64);
  const ms = performance.now() - t0;
  console.log(`${label}: 64x64 shells over unwritten ground ${ms.toFixed(0)} ms, ${b.length} B, skips ${t.stats.coverageSkips}, misses ${t.stats.missing}/${t.stats.missHits}`);
}
