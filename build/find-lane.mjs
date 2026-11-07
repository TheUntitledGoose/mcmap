// Where can a body actually walk in a straight line? Scan columns with the collision cells and answer
// with a lane: a run of columns where a 0.6 x 1.8 body stands clear, floor under its feet, and the
// floor height changes by at most a step. This is the tool that picks the coordinate a walk probe
// measures, so the probe measures walking and not a wall.
//
//   node build/find-lane.mjs --cx 12 --cz 10 --len 40
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { floorTop, hits } from '../shared/player.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const CX = +arg('cx', 12), CZ = +arg('cz', 10), LEN = +arg('len', 40), PAD = +arg('pad', 1);

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});

const held = new Map();
for (let cx = CX - PAD; cx <= CX + PAD; cx++) {
  for (let cz = CZ - PAD; cz <= CZ + PAD; cz++) {
    const buf = await svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!buf) continue;
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (!held.has(cx)) held.set(cx, new Map());
    held.get(cx).set(cz, openChunk(ab, 0));
  }
}
const cellAt = makeCellAt((cx, cz) => (held.get(cx)?.get(cz)) || null, () => assets);
const keyAt = (x, y, z) => {
  const c = held.get(x >> 4)?.get(z >> 4);
  if (!c) return '?';
  const id = c.stateAt(x & 15, y, z & 15);
  return id === 0 ? 'unknown' : (json.states[id - 1]?.k ?? '?');
};

/** The highest feet height in this column where a body stands clear, or null if none does. */
function standable(x, z) {
  const c = held.get(x >> 4)?.get(z >> 4);
  if (!c) return null;
  const ceil = c.surfaceAt(x & 15, z & 15);           // WORLD_SURFACE: nothing to stand on is above it
  if (!Number.isFinite(ceil) || ceil <= -2000) return null;
  for (let f = ceil + 1; f >= ceil - 40 && f > -64; f--) {   // surfaceAt is the top block's y, feet rest one above it
    // floorTop looks at the two cell layers around the feet, so ask it at an exact height.
    const top = floorTop(cellAt, x + 0.5, f, z + 0.5);
    if (!Number.isFinite(top) || Math.abs(top - f) > 1e-6) continue;   // feet must rest exactly here
    if (hits(cellAt, x + 0.5, f, z + 0.5) === 0) return { feet: f, on: keyAt(x, f - 1, z) };
  }
  return null;
}

const runs = [];
for (let z = (CZ - PAD) * 16; z < (CZ + PAD + 1) * 16; z++) {
  let run = [];
  for (let x = (CX - PAD) * 16; x < (CX + PAD + 1) * 16; x++) {
    const s = standable(x, z);
    if (s && run.length && Math.abs(s.feet - run[0].feet) <= 1) run.push({ x, z, ...s });
    else { if (run.length >= LEN) runs.push(run); run = s ? [{ x, z, ...s }] : []; }
  }
  if (run.length >= LEN) runs.push(run);
}
runs.sort((a, b) => b.length - a.length);
console.log(`${runs.length} lanes of ${LEN}+ blocks around chunk ${CX},${CZ} (+/-${PAD} chunks)`);
for (const r of runs.slice(0, 12)) {
  const mid = r[Math.floor(r.length / 2)];
  console.log(`  z ${r[0].z}..${r[r.length - 1].z} (${r.length} long) feet ${mid.feet}`
    + `  goto ${r[0].x + 0.5},${mid.feet + 1},${r[0].z + 0.5}  on ${mid.on}`);
}
