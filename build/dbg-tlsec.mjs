import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
const f = 'build/ledger/region.ledpack';
const pack = readPack(fs.readFileSync(f));
const buf = fs.readFileSync(f);
const TL = decodeTimeline(buf.subarray(pack.tlBytes[0], pack.tlBytes[1]));
const hist = new Map();
let zero = 0, zeroPlace = 0, place = 0;
const day = new Map();
for (let i = 0; i < TL.count; i++) {
  const s = TL.sec[i];
  hist.set(s, (hist.get(s) ?? 0) + 1);
  const d = Math.floor(s / 86400);
  day.set(d, (day.get(d) ?? 0) + 1);
  if (s === 0) { zero++; if (TL.action[i] === 1) zeroPlace++; }
  if (TL.action[i] === 1) place++;
}
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
const topDay = [...day.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
const placeSec = [];
for (let i = 0; i < TL.count; i++) if (TL.action[i] === 1) placeSec.push(TL.sec[i]);
placeSec.sort((a, b) => a - b);
const at = (p) => placeSec[Math.floor(p * (placeSec.length - 1))];
console.log(JSON.stringify({
  count: TL.count, place, base: TL.timeBaseSec, span: TL.spanSec,
  distinctSeconds: hist.size, rowsAtSec0: zero, placeAtSec0: zeroPlace,
  topSeconds: top, topDays: topDay,
  placeQuantiles: [0, 0.25, 0.5, 0.75, 0.9, 1].map((p) => [p, at(p), new Date((TL.timeBaseSec + at(p)) * 1000).toISOString().slice(0, 19)]),
  placeLastSec: placeSec[placeSec.length - 1],
  placeLastDate: new Date((TL.timeBaseSec + placeSec[placeSec.length - 1]) * 1000).toISOString().slice(0, 19),
}, null, 1));
