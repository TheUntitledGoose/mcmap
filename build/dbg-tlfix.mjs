import { decodeTimeline, readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
const T = (s) => 1717174690000 + s * 1000;
const FIX = [
  [1, 0, 64, 0, 2, 1, T(100)],
  [1, 1, 64, 0, 2, 1, T(110)],
  [1, 1, 64, 0, 3, 1, T(120)],
  [1, 1, 64, 0, 2, 1, T(130)],
  [1, 2, 65, 3, 2, 2, T(140)],
  [1, 3, 66, 3, 1, 0, T(150)],
  [1, 4, 64, 4, 6, 0, T(160)],
  [1, 20, 64, 20, 2, 1, T(170)],
];
const R = FIX.map(([worldId, x, y, z, actionId, playerId, timeMs]) => ({ worldId, x, y, z, actionId, playerId, timeMs }));
const L = { count: R.length, worldId: (i)=>R[i].worldId, x:(i)=>R[i].x, y:(i)=>R[i].y, z:(i)=>R[i].z,
  actionId:(i)=>R[i].actionId, playerId:(i)=>R[i].playerId, timeMs:(i)=>R[i].timeMs };
const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
const pack = readPack(buf);
const tl = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
console.log('count', tl.count, 'base', tl.timeBaseSec, 'span', tl.spanSec);
for (let i = 0; i < tl.count; i++) {
  const c = pack.cell(tl.cellOf(i));
  console.log(i, 'sec', tl.sec[i], 'act', tl.action[i], 'who', tl.player[i],
    'cell', tl.cellOf(i), `chunk ${c.cx},${c.cz}`, 'w', c.cx*16+tl.x(i), tl.y(i), c.cz*16+tl.z(i));
}
