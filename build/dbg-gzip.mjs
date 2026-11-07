// Is the gzip in send() paying for anything on the binary endpoints?
// The payload batch is already deflate-compressed per chunk, so the question is what a second
// layer costs and what it saves.
import zlib from 'node:zlib';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import fs from 'node:fs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const ids = buildStateIds(atlas.states.map((x) => x.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {});
const DIM = 'minecraft:overworld';

const cases = [
  ['voxels 6x6 real ground', await svc.batchBytesAsync(DIM, -20, -30, 6, 6)],
  ['shells 64x64 real ground', await svc.shellBatchBytesAsync(DIM, -20, -30, 64, 64)],
  ['meta json', Buffer.from(JSON.stringify({ dims: svc.dimList(), states: atlas.states.length }))],
];

for (const [name, body] of cases) {
  if (!body) { console.log(name, 'no body'); continue; }
  const t0 = performance.now();
  const gz = zlib.gzipSync(body, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
  const msDef = performance.now() - t0;
  const t1 = performance.now();
  const gz1 = zlib.gzipSync(body, { level: 1 });
  const ms1 = performance.now() - t1;
  console.log(
    `${name}: ${body.length} B -> gzip ${gz.length} B in ${msDef.toFixed(1)} ms` +
    ` | level 1 ${gz1.length} B in ${ms1.toFixed(1)} ms` +
    ` | saved ${(100 * (1 - gz.length / body.length)).toFixed(1)}%`);
}
