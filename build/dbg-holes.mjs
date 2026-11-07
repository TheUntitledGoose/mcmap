// What does one unwritten chunk slot cost the server? This prices the request path itself (no HTTP),
// against the previous world-service, in a fresh cache directory each: the question is what a far pan
// over the 294 partially filled overworld regions pays per hole, and what it leaves behind.
//
//   git show HEAD:server/world-service.mjs > server/_old_ws.tmp.mjs
//   node build/dbg-holes.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const ids = buildStateIds(atlas.states.map((s) => s.k));
const opts = { packDir: 'none', cacheMaxGb: 8 };

// A 24x24 window of holes, stepped across the sparse corner of the overworld: the same kind of swept
// area a pull-back produces, just without a browser in front of it.
const STEPS = [];
for (let k = 0; k < 40; k++) STEPS.push([-128 + k * 24, 576]);
const N = 24;

function countFiles(dir) {
  let n = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ent;
    try { ent = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { n++; try { bytes += fs.statSync(p).size; } catch { } }
    }
  }
  return { n, bytes };
}

const out = {};
for (const [label, mod] of [['HEAD', '../server/_old_ws.tmp.mjs'], ['now', '../server/world-service.mjs']]) {
  const { WorldService } = await import(mod);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holes-'));
  const svc = new WorldService('DarkRPG/world', ids, dir, opts);
  let nulls = 0, lookups = 0;
  const t0 = performance.now();
  for (const [cx, cz] of STEPS) {
    for (let dz = 0; dz < N; dz++) {
      for (let dx = 0; dx < N; dx++) {
        lookups++;
        if (svc.chunkBytes('minecraft:overworld', cx + dx, cz + dz) === null) nulls++;
      }
    }
  }
  const ms = performance.now() - t0;
  const files = countFiles(dir);
  out[label] = {
    ms: +ms.toFixed(0), perLookupUs: +((ms * 1000) / lookups).toFixed(1), nulls, lookups,
    filesLeft: files.n, fileBytesKB: +(files.bytes / 1024).toFixed(0),
    stats: { ...svc.stats, cacheBytes: undefined },
  };
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
