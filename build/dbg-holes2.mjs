// Where does a lookup of unwritten ground actually go? Timed in pieces, at a chunk coordinate where the
// region file exists but the slot does not, then at one where the region file does not exist either.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const { WorldService } = await import('../server/world-service.mjs');
const { RegionFile } = await import('../tools/region.mjs');
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, fs.mkdtempSync(path.join(os.tmpdir(), 'h2-')), { packDir: 'none' });
const N = 4000, rep = 3;
function timeIt(label, fn) {
  let best = Infinity;
  for (let r = 0; r < rep; r++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) fn(i);
    best = Math.min(best, performance.now() - t0);
  }
  console.log(label.padEnd(34), (best * 1000 / N).toFixed(1) + ' us/slot');
}
const DIM = 'minecraft:overworld';
timeIt('hole in a present region', () => svc.chunkBytes(DIM, -128, 576));
timeIt('slot in a missing region', () => svc.chunkBytes(DIM, -2500, 576));
const dim = svc.resolve(DIM);
timeIt('path.join + map.get only', () => svc.regions.get(path.join(dim.dir, 'r.-4.18.mca')));
const rf = new RegionFile(path.join(dim.dir, 'r.-4.18.mca'));
timeIt('fresh RegionFile.entry() call', () => rf.entry(0, 0));
const t0 = performance.now();
for (let i = 0; i < N; i++) svc.chunkBytes(DIM, -128 + (i & 31), 576 + ((i >> 5) & 31));
console.log('walk 4096 slots across one region  ', (performance.now() - t0).toFixed(0) + ' ms total,',
  ((performance.now() - t0) * 1000 / N).toFixed(1) + ' us/slot');
