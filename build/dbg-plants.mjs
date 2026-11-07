// Which plant-ish state names does the collision table currently think are solid?
// Name the family from the real state table instead of guessing one word at a time.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { C_CLIMB, C_FULL, C_LIQUID, C_PASS, C_UNKNOWN, h16Of } from '../shared/player.mjs';

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const A = new Assets(json, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const NAME = { [-1]: 'UNKNOWN', 0: 'pass', 16: 'FULL', 32: 'CLIMB', 64: 'LIQUID' };
const CODE = { UNKNOWN: -1, pass: 0, FULL: 16, CLIMB: 32, LIQUID: 64 };

const re = /(grass|fern|bush|shrub|sprout|root|flower|crop|leaf|leaves|vine|reed|bamboo|cane|kelp|moss|lichen|peppers|flax|cactus|sapling|seedling|stem|branch|seed|fruit|berry|log|blossom|drip|hang)/i;
const groups = {};
for (let i = 0; i < json.states.length; i++) {
  const s = json.states[i];
  const bare = s.k.split('|')[0];
  const name = bare.includes(':') ? bare.split(':')[1] : bare;
  if (!re.test(name)) continue;
  const cell = A.collisionOf(i + 1);
  const key = NAME[cell] ?? String(cell);
  (groups[key] ||= new Map()).set(bare, { h16: h16Of(cell), film: s.film ? 1 : 0, cube: s.cube ? 1 : 0 });
}
for (const k of ['FULL', 'CLIMB', 'LIQUID', 'pass', 'UNKNOWN']) {
  const m = groups[k];
  if (!m) continue;
  const bare = [...m.keys()];
  console.log(`${k}: ${m.size} blocks`);
  console.log(`   ${bare.slice(0, 60).join(', ')}`);
}
void C_FULL; void C_PASS; void C_CLIMB; void C_LIQUID; void C_UNKNOWN; void CODE;
