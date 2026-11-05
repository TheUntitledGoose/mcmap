import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
const a = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const A = new Assets(a, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.length));
for (const k of ['minecraft:stone', 'minecraft:air', 'minecraft:grass_block|snowy=false']) {
  const i = A.indexOf(k);
  console.log(k, '->', i, i >= 0 ? JSON.stringify(A.states[i]).slice(0, 90) : '');
}
