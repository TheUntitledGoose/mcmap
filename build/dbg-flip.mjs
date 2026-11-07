// Audit the geometry plant rule against the real asset pack: which states stop blocking a walking body,
// which start, and how many blocks of the world each one is. The point is to be able to say "this rule
// changes N blocks of world, and here are the blocks", not "trust the rule".
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { collisionTable, F_FLAT, F_NONE, F_THIN, h16Of } from '../shared/player.mjs';

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const A = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const NAME = { [-1]: 'UNKNOWN', 0: 'pass', 16: 'FULL', 32: 'CLIMB', 64: 'LIQUID' };

// Rebuild the same table without the footprint argument: that is what the physics saw before.
// The census counts how many blocks of the world each state is; atlas.json does not.
const census = fs.existsSync('build/census.json') ? JSON.parse(fs.readFileSync('build/census.json', 'utf8')) : null;
const samplesOf = new Map();
if (census) for (const s2 of census.states) samplesOf.set(s2.key, s2.samples ?? 0);

const before = collisionTable(A.states, A.stateAir, A.stateFilm, A.stateHeight);
const after = A.stateCollision;
const FOOT = { 0: 'no quads', 1: 'all vertical', 2: 'has a flat quad' };

const off = [], on = [];
for (let i = 0; i < A.states.length; i++) {
  if (before[i] === after[i]) continue;
  const rec = { k: A.states[i].k, from: NAME[before[i]] ?? before[i], to: NAME[after[i]] ?? after[i],
    h16: h16Of(before[i]), foot: FOOT[A.stateFoot[i]], samples: samplesOf.get(A.states[i].k) ?? 0 };
  (after[i] === 0 ? off : on).push(rec);
}
const bySamples = (a, b) => (b.samples ?? 0) - (a.samples ?? 0);
off.sort(bySamples); on.sort(bySamples);
const uniq = (list) => [...new Map(list.map((r) => [r.k.split('|')[0], r])).values()];

console.log(`states whose collision changed: ${off.length} became passable, ${on.length} became blocking`);
let offSamples = 0, onSamples = 0;
for (const r of off) offSamples += r.samples ?? 0;
for (const r of on) onSamples += r.samples ?? 0;
console.log(`world samples affected: ${offSamples.toLocaleString()} walk-through now, ${onSamples.toLocaleString()} blocking now`);
console.log('\n-- now walkable (was a wall), the 25 blocks with the most samples --');
for (const r of uniq(off).slice(0, 25)) {
  console.log(`   ${r.k.padEnd(62)} ${r.from}->${r.to} h16 ${String(r.h16).padStart(2)}  ${r.foot}  samples ${r.samples}`);
}
console.log('\n-- plant-ish names that still block, so the rule is not eating something solid --');
const re = /(grass|fern|bush|shrub|sprout|root|flower|crop|vine|reed|bamboo|kelp|moss|lichen|flax|sapling|stem|branch|drip|hang)/i;

const stillFull = [];
for (let i = 0; i < A.states.length; i++) {
  const bare = A.states[i].k.split('|')[0];
  const name = bare.includes(':') ? bare.split(':')[1] : bare;
  if (!re.test(name)) continue;
  if (after[i] === 0) continue;
  stillFull.push(`${bare} [${NAME[after[i]] ?? after[i]} h16 ${h16Of(after[i])} ${FOOT[A.stateFoot[i]]}]`);
}
console.log(`   ${[...new Set(stillFull)].slice(0, 40).join(', ')}`);
console.log(`\nfootprint census: F_NONE ${A.stateFoot.filter((v) => v === F_NONE).length},`
  + ` F_THIN ${A.stateFoot.filter((v) => v === F_THIN).length},`
  + ` F_FLAT ${A.stateFoot.filter((v) => v === F_FLAT).length} of ${A.stateFoot.length} states`);
