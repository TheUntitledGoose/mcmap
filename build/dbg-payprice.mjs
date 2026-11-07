// What does one cached chunk cost the server on the request path? The pan numbers say a 6x6 payload tile
// costs ~64 ms with zero decodes, so the money is in the read path. Priced here: the file read, the
// inflate, the batch copy, and chunkBytes end to end.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const { WorldService } = await import('../server/world-service.mjs');
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', { packDir: 'build/shells' });
const DIM = 'minecraft:overworld';
const SPOTS = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]];
for (const [cx, cz] of SPOTS) svc.chunkBytes(DIM, cx, cz);
const one = svc.chunkBytes(DIM, 0, 0);
console.log('payload for 0,0:', one.length, 'bytes;  tableTag', svc.tableTag, ' lightTag', svc.lightTag);
const cfile = path.join('build/cache', String(svc.tableTag), svc.lightTag ? 'lit' : 'nolight',
  svc.resolve(DIM).key, '0_0.bin');
console.log('cache file:', cfile, fs.existsSync(cfile) ? fs.statSync(cfile).size + ' B' : 'MISSING');
const stored = fs.existsSync(cfile) ? fs.readFileSync(cfile) : null;

function timeIt(label, n, fn) {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    best = Math.min(best, performance.now() - t0);
  }
  console.log(label.padEnd(40), (best * 1000 / n).toFixed(3) + ' ms/call');
}
timeIt('chunkBytes same chunk', 300, () => svc.chunkBytes(DIM, 0, 0));
timeIt('chunkBytes 6 rotating chunks', 300, (i) => svc.chunkBytes(DIM, ...SPOTS[i % 6]));
if (stored) {
  timeIt('readFileSync of its cache file', 300, () => fs.readFileSync(cfile));
  timeIt('inflateSync of its stored bytes', 300, () => zlib.inflateSync(stored.subarray(4)));
}
const frames = SPOTS.map(([cx, cz]) => svc.chunkBytes(DIM, cx, cz) ?? Buffer.alloc(0));
timeIt('chunkBytes + packBatch for a 6x6 tile', 60, () => {
  const fs2 = SPOTS.map(([cx, cz]) => svc.chunkBytes(DIM, cx, cz) ?? Buffer.alloc(0));
  const out = Buffer.alloc(fs2.reduce((a,b)=>a+4+((b.length+3)&~3),8)); let p=8; for (const b of fs2) { out.writeUInt32LE(b.length,p); p+=4; b.copy(out,p); p+=(b.length+3)&~3; } return out;
});
const { packBatch } = await import('../shared/batch.mjs').catch(() => ({}));
console.log('stats', JSON.stringify(svc.stats));
