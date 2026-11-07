// What the walking body would feel in one real column: the voxel truth from the payload, the asset
// pack's collision byte for each state, and the block name, side by side.
//
//   node build/dbg-collide.mjs --cx 127 --cz 169 --x 10 --z 14 --y1 90 --y0 -60
//
// The oracle for the names is:
//   node tools/column.mjs --cx 127 --cz 169 --x 10 --z 14 --y1 150 --y0 -60
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { C_PASS, C_FULL, C_CLIMB, C_LIQUID, C_UNKNOWN, h16Of, newPlayer, simulate, floorTop, BODY } from '../shared/player.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const cx = +flag('cx', 127), cz = +flag('cz', 169), lx = +flag('x', 10), lz = +flag('z', 14);
const y1 = +flag('y1', 90), y0 = +flag('y0', -60);

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), 'build/cache', {});
const dim = flag('dim', 'minecraft:overworld');
const buf = await svc.chunkBytes(dim, cx, cz);
const chunk = openChunk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 0);
const cellAt = makeCellAt((a, b) => (a === cx && b === cz ? chunk : null), () => assets);

console.log(`chunk ${cx},${cz} ${dim}  stored sections y ${chunk.yMin}..${chunk.yMin + chunk.yCount - 1}`);

const label = (v) => (v === C_PASS ? 'pass' : v === C_FULL ? 'FULL' : v === C_CLIMB ? 'climb'
  : v === C_LIQUID ? 'liquid' : v === C_UNKNOWN ? '???' : `h${v}`);
const nameOf = (y) => {
  const s16 = y >> 4;
  if (s16 < chunk.yMin || s16 >= chunk.yMin + chunk.yCount || !chunk.sectionAt(y)) return '(not stored)';
  const id = chunk.stateAt(lx, y, lz);
  return id === 0 ? '<unknown state>' : json.states[id - 1].k;
};

// Run-length the column: a 26 block wall of deepslate should be one line.
const runs = [];
for (let y = y1; y >= y0; y--) {
  const v = cellAt(cx * 16 + lx, y, cz * 16 + lz);
  const n = nameOf(y);
  const prev = runs[runs.length - 1];
  if (prev && prev.v === v && prev.name === n) prev.lo = y;
  else runs.push({ y, lo: y, v, name: n });
}
console.log(`\n-- column world (${cx * 16 + lx}, ${cz * 16 + lz}) as the physics sees it --`);
for (const r of runs) {
  const h = h16Of(r.v);
  console.log(`  y ${String(r.y).padStart(4)} .. ${String(r.lo).padStart(4)}  ${label(r.v).padStart(5)}` +
    `  ${h ? `top ${(r.y + h / 16).toFixed(2)}` : '         '}  ${r.name}`);
}

// Where a body released at the top of the window comes to rest.
const wx = cx * 16 + lx + 0.5, wz = cz * 16 + lz + 0.5;
for (const start of [y1, 20, 66]) {
  const p = newPlayer(wx, start, wz);
  for (let i = 0; i < 6000; i++) simulate(p, {}, 1 / 60, cellAt, { minY: chunk.yMin * 16 });
  console.log(`  released feet ${String(start).padStart(4)} -> feet ${p.y.toFixed(2)}` +
    ` (eye ${(p.y + BODY.eye).toFixed(2)})  onGround ${p.onGround}  fell ${p.fell.toFixed(1)}` +
    `  frozen ${p.frozen}  floorTop ${floorTop(cellAt, p.x, p.y, p.z)}`);
}

// The judgement calls: names whose rule is not a shape. This is empirical - it reports what this save
// actually contains, not what vanilla's collision table says it should contain.
const want = ['ladder', 'vine', 'scaffolding', 'water', 'seagrass', 'kelp', 'torch', 'redstone_torch',
  'lantern', 'chain', 'carpet', 'snow', 'air', 'glass', 'fence', 'iron_bars', 'stairs', 'slab',
  'leaves', 'web', 'cobweb', 'grass!', 'tall_grass', 'fern', 'sapling', 'button', 'lever', 'sign',
  'bed', 'anvil', 'gate', 'door', 'trapdoor', 'shulker', 'table', 'pot', 'book', 'torch_wall'];
console.log('\n-- rules for named states in this asset pack --');
const shown = new Map();
for (let i = 0; i < json.states.length; i++) {
  const k = json.states[i].k, name = k.split('|')[0].split(':').pop();
  if (!want.some((p) => (p.endsWith('!') ? name === p.slice(0, -1) : name.includes(p)))) continue;
  const v = assets.stateCollision[i];
  const key = `${k.split('|')[0]}  ${label(v).padStart(5)}  h=${h16Of(v)}`;
  shown.set(key, (shown.get(key) || 0) + 1);
}
for (const k of [...shown.keys()].sort()) console.log(`  ${String(shown.get(k)).padStart(4)}x  ${k}`);
