// Does the previous world-service hang when a far pan touches 60 unwritten region files and then pans
// back onto real ground? Run it under a hard timeout: if the last line never prints, the loop was not
// slow, it was gone. Use a FRESH cache directory, so the pan back really does open region files.
//   git show HEAD:server/world-service.mjs > server/_old_ws.tmp.mjs
//   timeout 25 node build/dbg-spin.mjs ../server/_old_ws.tmp.mjs ; echo "exit $?"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const which = process.argv[2] ?? '../server/world-service.mjs';
const { WorldService } = await import(which);
const ids = buildStateIds(atlas.states.map((s) => s.k));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-'));
const s = new WorldService('DarkRPG/world', ids, cache, { packDir: null });
const DIM = 'minecraft:overworld';
console.log('module', which);
const miss = [];
for (let rz = 0; rz < 6; rz++) for (let rx = 0; rx < 10; rx++) miss.push([32 * rx + 4000, 32 * rz + 4000]);
for (const [cx, cz] of miss) s.chunkBytes(DIM, cx, cz);
for (const [cx, cz] of miss) s.chunkBytes(DIM, cx, cz);
console.log('paths kept in the eviction list after 60 absent regions:', s.order.length);
const t0 = performance.now();
for (let rz = 0; rz < 4; rz++) for (let rx = 0; rx < 4; rx++) s.chunkBytes(DIM, 32 * rx, 32 * rz);
console.log('pan back onto real ground:', (performance.now() - t0).toFixed(0), 'ms,', JSON.stringify(s.stats));
fs.rmSync(cache, { recursive: true, force: true });
