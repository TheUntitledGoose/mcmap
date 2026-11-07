import { decodeTimeline, readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { buildTimeQuads, filterRows, actionLinear } from '../web/js/ledger-time.mjs';
const T = (s) => 1717174690000 + s * 1000;
const FIX = [
  [1, 0, 64, 0, 2, 1, T(100)], [1, 1, 64, 0, 2, 1, T(110)], [1, 1, 64, 0, 3, 1, T(120)],
  [1, 1, 64, 0, 2, 1, T(130)], [1, 2, 65, 3, 2, 2, T(140)], [1, 3, 66, 3, 1, 0, T(150)],
  [1, 4, 64, 4, 6, 0, T(160)], [1, 20, 64, 20, 2, 1, T(170)],
];
const R = FIX.map(([worldId, x, y, z, actionId, playerId, timeMs]) => ({ worldId, x, y, z, actionId, playerId, timeMs }));
const L = { count: R.length, worldId: (i)=>R[i].worldId, x:(i)=>R[i].x, y:(i)=>R[i].y, z:(i)=>R[i].z,
  actionId:(i)=>R[i].actionId, playerId:(i)=>R[i].playerId, timeMs:(i)=>R[i].timeMs };
const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
const pack = readPack(buf);
const tl = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
const g = buildTimeQuads(tl, pack, filterRows(tl).order);
const col = (q) => [g.col[q * 12], g.col[q * 12 + 1], g.col[q * 12 + 2]];
console.log('want place', actionLinear(2));
for (let q = 0; q < 8; q++) console.log(q, col(q));
