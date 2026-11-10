import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const keyOf = (i) => tl.cellOf(i) * 2097152 + ((tl.y(i) + 4096) << 8) + ((tl.z(i) & 15) << 4) + (tl.x(i) & 15);
const worldOf = (i) => { const c = P.cell(tl.cellOf(i)); return [c.cx * 16 + tl.x(i), tl.y(i), c.cz * 16 + tl.z(i)]; };
// the rows the browser attributed to -58,66,-132
for (const sec of [93110, 94005, 94006]) {
  const rows = [];
  for (let i = 0; i < tl.count; i++) if (tl.sec[i] === sec) rows.push(i);
  console.log(`sec ${sec}: ${rows.length} rows`,
    rows.slice(0, 6).map((i) => `${worldOf(i).join(',')} cell${tl.cellOf(i)} act${tl.action[i]} ${tl.nameOf(i)} key${keyOf(i)}`));
}
// and the key the browser computed for the stone row
const stone = (() => { for (let i = 0; i < tl.count; i++) { const c = P.cell(tl.cellOf(i));
  if (c.cx * 16 + tl.x(i) === -58 && tl.y(i) === 66 && c.cz * 16 + tl.z(i) === -132) return i; } return -1; })();
console.log('stone row', stone, 'key', keyOf(stone), 'cell', tl.cellOf(stone));
console.log('key decode back:', (() => { const k = keyOf(stone), cell = Math.floor(k / 2097152), rest = k - cell * 2097152;
  return { cell, x: rest & 15, y: (rest >> 8) - 4096, z: (rest >> 4) & 15 }; })());
