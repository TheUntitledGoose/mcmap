// The panel said "7,007 / 90,045 place rows" at playhead 2024-06-01 23:00:38 while a whole house stood.
// Which rows does that moment actually cover, and does the base area have rows on either side of it?
import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
const raw = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(raw);
const tl = decodeTimeline(raw.subarray(pack.tlBytes[0], pack.tlBytes[1]));
const base = tl.timeBaseSec;
const PH = Math.floor(new Date('2024-06-01T23:00:38+02:00').getTime() / 1000) - base;
console.log(`timeBase ${base}  playhead sec ${PH}  (${new Date((base + PH) * 1000).toISOString()})`);
let behind = 0, newer = 0;
for (let i = 0; i < tl.count; i++) {
  if (tl.action[i] !== 1) continue;                       // 1 = block-place
  if (tl.sec[i] <= PH) behind++; else newer++;
}
console.log(`place rows at/behind playhead ${behind}, newer ${newer}`);

const cellOf = new Map();
for (let i = 0; i < pack.cellCount; i++) { const c = pack.cell(i); cellOf.set(`${c.cx},${c.cz}`, i); }
const want = process.argv.slice(2);
for (const w of want) {
  const [cx, cz] = w.split(',').map(Number);
  const ci = cellOf.get(w);
  if (ci === undefined) { console.log(`${w}: no rows at all in the pack`); continue; }
  const rows = [];
  for (let i = 0; i < tl.count; i++) if (tl.cellOf(i) === ci) rows.push(i);
  const ph = { behind: 0, newer: 0 }; const byAction = {};
  const yHist = {}; let minSec = 1e18, maxSec = 0;
  for (const i of rows) {
    byAction[tl.action[i]] = (byAction[tl.action[i]] || 0) + 1;
    if (tl.action[i] === 1) { tl.sec[i] <= PH ? ph.behind++ : ph.newer++; }
    const y = tl.y(i); yHist[y] = (yHist[y] || 0) + 1;
    minSec = Math.min(minSec, tl.sec[i]); maxSec = Math.max(maxSec, tl.sec[i]);
  }
  const ys = Object.keys(yHist).map(Number).sort((a, b) => a - b);
  console.log(`${w}: ${rows.length} rows actions ${JSON.stringify(byAction)} `
    + `places behind ${ph.behind} newer ${ph.newer} `
    + `span ${minSec}-${maxSec} (${new Date((base + minSec) * 1000).toISOString()} .. ${new Date((base + maxSec) * 1000).toISOString()}) `
    + `y ${ys[0]}..${ys[ys.length - 1]}`);
}
