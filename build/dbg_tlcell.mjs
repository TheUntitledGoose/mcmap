import fs from 'node:fs';
import { decodeTimeline, readPack } from '../shared/ledger-pack.mjs';

const b = fs.readFileSync('build/ledger/region.ledpack');
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const p = readPack(Buffer.from(ab) instanceof Buffer ? ab : ab);
const tl = decodeTimeline(new Uint8Array(ab, p.tlBytes[0], p.tlBytes[1] - p.tlBytes[0]));
console.log('pack cells', p.cellCount, 'tl count', tl.count, 'tl cells?', tl.cellCount ?? '(n/a)');
const c0 = p.cell(0), c1 = p.cell(1);
console.log('pack cell 0', c0, 'cell 1', c1);
let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, bad = 0;
const seen = new Set();
for (let i = 0; i < tl.count; i++) {
  const ci = tl.cellOf(i);
  if (!seen.has(ci)) { seen.add(ci); }
  const c = p.cell(ci);
  if (!c) { bad++; continue; }
  const x = c.cx * 16 + tl.x(i), z = c.cz * 16 + tl.z(i);
  if (x < minx) minx = x; if (x > maxx) maxx = x;
  if (z < minz) minz = z; if (z > maxz) maxz = z;
}
console.log('row x range', minx, maxx, ' z range', minz, maxz, 'bad', bad, 'distinct cells used', seen.size);
// what does the place-filter look like at the end, item by item?
const place = [];
for (let i = 0; i < tl.count; i++) if (tl.action[i] === 2) place.push(i);
console.log('place rows', place.length, 'first', place[0], 'last', place[place.length - 1]);
for (const k of [0, 1, place.length - 2, place.length - 1]) {
  const row = place[k], c = p.cell(tl.cellOf(row));
  console.log('item', k, 'row', row, 'cellIdx', tl.cellOf(row), 'cell', c && [c.cx, c.cz],
    'voxel', c && [c.cx * 16 + tl.x(row), tl.y(row), c.cz * 16 + tl.z(row)], 'name', tl.nameOf?.(row));
}
