// Find real voxels where this log makes more than one claim - so a browser probe can aim at one and ask
// which claim owns the pixel. A place followed later by a break at one voxel is the case a person reported:
// a green marker and a red marker occupying the same block.
import fs from 'node:fs';
import path from 'node:path';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
const t0 = Date.now();
const meta = JSON.parse(fs.readFileSync('build/ledger/meta.json', 'utf8'));
const arg = process.argv.find((a) => a.startsWith('--dim='))?.slice(6) ?? 'minecraft:overworld';
const d = meta.dims.find((x) => x.pack === arg || x.dimId === arg || x.dimKey === arg) ?? meta.dims[0];
const near = (process.argv.find((a) => a.startsWith('--near=')) ?? '--near=0,0,0').slice(7).split(',').map(Number);
const R = Number((process.argv.find((a) => a.startsWith('--r=')) ?? '--r=64').slice(4));
const buf = fs.readFileSync(path.join('build/ledger', d.pack));
const P = readPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
if (!tl.count) throw new Error('no timeline in this pack');

// cell + packed coord -> [firstRow, lastRow, claimCount]. Rows are ascending in time, so the first row seen
// at a voxel is its oldest claim and the last is its newest.
const first = new Map(), last = new Map(), count = new Map();
for (let i = 0; i < tl.count; i++) {
  const k = tl.cellOf(i) * 2097152 + ((tl.y(i) + 4096) << 8) + ((tl.z(i) & 15) << 4) + (tl.x(i) & 15);
  if (!first.has(k)) first.set(k, i);
  last.set(k, i);
  count.set(k, (count.get(k) ?? 0) + 1);
}
const ACT = ['change', 'place', 'break', 'insert', 'remove', 'kill', 'other'];
const hits = [];
for (const [k, a] of first) {
  const b = last.get(k);
  if (b === a) continue;
  const c = P.cell(tl.cellOf(a));   // the row index knows its cell; decoding the key would be a second truth
  const wx = c.cx * 16 + tl.x(a), wz = c.cz * 16 + tl.z(a), wy = tl.y(a);
  const dist = Math.max(Math.abs(wx - near[0]), Math.abs(wz - near[2]), Math.abs(wy - near[1]));
  if (dist > R) continue;
  hits.push({ wx, wy, wz, dist, n: count.get(k),
    a: [tl.action[a], tl.nameOf(a), tl.sec[a]], b: [tl.action[b], tl.nameOf(b), tl.sec[b]] });
}
hits.sort((u, v) => (u.dist - v.dist) || (v.n - u.n));
console.log(`${d.dimId}: ${tl.count} timeline rows; ${hits.length} stacked voxels within ${R} blocks of ${near.join(', ')}`);
for (const h of hits.slice(0, 14)) {
  console.log(`  ${h.wx},${h.wy},${h.wz}  ${h.n} claims  d=${h.dist}`
    + `  oldest=${ACT[h.a[0]]} ${h.a[1]} @${h.a[2]}s  newest=${ACT[h.b[0]]} ${h.b[1]} @${h.b[2]}s`);
}
const pb = hits.filter((h) => h.a[0] === 1 && h.b[0] === 2).length;
console.log(`# of these, oldest=place and newest=break: ${pb}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
