import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { fakeLog } from '../tests/fake-ledger.mjs';

const T = (s) => 1717174690000 + s * 1000;
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));

function build(rows, opts = {}) {
  const L = fakeLog(rows.map(([x, y, z, aid, name, old, sec]) => [1, x, y, z, aid, 1, T(sec), name, old]));
  const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  console.log('tl rows', tl.count, 'actions', Array.from(tl.action), 'names', [...Array(tl.count).keys()].map((i) => tl.nameOf(i)));
  resetMarkerLift();
  const out = buildTimeBlocks(tl, P, Array.from({ length: tl.count }, (_, i) => i), assets, stateIdsByName(assets.states), opts);
  console.log('stats', out.stats);
  console.log('markerSec', Array.from(out.markerSec), 'markerEnd', Array.from(out.markerEnd));
  return out;
}
console.log('--- place stone');
build([[2, 64, 3, 2, 'minecraft:stone', 'minecraft:air', 10]]);
console.log('--- break stone (old air)');
build([[2, 64, 3, 3, 'minecraft:stone', 'minecraft:air', 10]]);
console.log('--- break stone (name stone, old stone)');
build([[2, 64, 3, 3, 'minecraft:stone', 'minecraft:stone', 10]]);
