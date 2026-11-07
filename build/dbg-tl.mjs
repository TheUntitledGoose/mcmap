// What is actually on the timeline of the baked overworld pack: who, what action, how big.
import { readFileSync } from 'node:fs';
import { readPack, decodeTimeline, TL_NO_PLAYER } from '../shared/ledger-pack.mjs';

const raw = readFileSync('build/ledger/region.ledpack');
const P = readPack(raw);
const TL = decodeTimeline(raw.subarray(P.tlBytes[0], P.tlBytes[1]));
const per = new Int32Array(256);
const perAct = new Int32Array(8);
for (let i = 0; i < TL.count; i++) { per[TL.player[i]]++; perAct[TL.action[i]]++; }
const meta = JSON.parse(readFileSync('build/ledger/meta.json', 'utf8'));
const name = (id) => meta.players.find((p) => p.id === id)?.name ?? `#${id}`;
const show = (arr, f) => [...arr.entries()].filter(([, v]) => v).map(([k, v]) => `${f(k)}=${v}`).join('  ');
console.log('players      ', show(per, (k) => (k === TL_NO_PLAYER ? 'none' : name(k + 1))));
console.log('actions      ', show(perAct, (k) => k + 1));
console.log('tl bytes     ', P.tlBytes[1] - P.tlBytes[0]);
console.log('cells slice  ', 44 + P.dimKey.length + P.cellCount * 34);
console.log('rows/cells   ', TL.count, P.cellCount);
console.log('base/sec0/end', TL.timeBaseSec, TL.sec[0], TL.sec[TL.count - 1]);
const y0 = TL.y(0), y1 = TL.y(1);
console.log('row0', P.cell(TL.cellOf(0)).cx * 16 + TL.x(0), y0, P.cell(TL.cellOf(0)).cz * 16 + TL.z(0));
console.log('y range      ', Math.min(...Array.from({ length: 5000 }, (_, i) => TL.y(i * 70 % TL.count))));
