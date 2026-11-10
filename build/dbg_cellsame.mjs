import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const target = [-58, 66, -132];
const cellsForChunk = new Map();
for (let i = 0; i < P.cellCount; i++) {
  const c = P.cell(i);
  const k = `${c.cx},${c.cz}`;
  if (!cellsForChunk.has(k)) cellsForChunk.set(k, []);
  cellsForChunk.get(k).push(i);
}
let dup = 0, dupEx = [];
for (const [k, v] of cellsForChunk) if (v.length > 1) { dup++; if (dupEx.length < 5) dupEx.push([k, v]); }
console.log(`cells ${P.cellCount}, chunks ${cellsForChunk.size}, chunks with >1 cell: ${dup}`, JSON.stringify(dupEx));
const hits = [];
for (let i = 0; i < tl.count; i++) {
  const c = P.cell(tl.cellOf(i));
  if (c.cx * 16 + tl.x(i) === target[0] && c.cz * 16 + tl.z(i) === target[2] && tl.y(i) === target[1]) {
    hits.push({ row: i, cell: tl.cellOf(i), chunk: `${c.cx},${c.cz}`, act: tl.action[i],
      name: tl.nameOf(i), sec: tl.sec[i] });
  }
}
console.log(`rows at ${target.join(',')}: ${hits.length}`);
for (const h of hits.slice(0, 12)) console.log(' ', JSON.stringify(h));
