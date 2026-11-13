// Is a marker set honest about the MOMENT? Two ways it can lie, both measured here over the shipped pack:
//  1. dropping a repeat of a voxel and keeping only its newest claim means the voxel draws NOTHING at a
//     playhead before that newest claim - even though a claim of its own had already happened.
//  2. culling a face because the neighbour voxel is claimed SOMEWHERE in the filter, when that neighbour's
//     own claim happens LATER than this marker - so the face is gone and the block behind it is not drawn.
// node build/dbg-prefixskip.mjs [actionClass: 1=place 0=any]
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { DIRS, FACE_DIR } from '../shared/faces.mjs';

const wantAction = +(process.argv[2] ?? 1);
const FACE_OFF = DIRS.map((d) => FACE_DIR[d]);
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const nameIds = stateIdsByName(assets.states);
const key = (i) => { const c = P.cell(tl.cellOf(i)); return `${c.cx * 16 + tl.x(i)},${tl.y(i)},${c.cz * 16 + tl.z(i)}`; };

const order = [];
for (let i = 0; i < tl.count; i++) if (tl.action[i] === wantAction || wantAction === 0) order.push(i);
const keys = order.map(key);
const firstAt = new Map();                        // voxel -> first order index claiming it
for (let k = 0; k < order.length; k++) if (!firstAt.has(keys[k])) firstAt.set(keys[k], k);
const lastAt = new Map();
for (let k = 0; k < order.length; k++) lastAt.set(keys[k], k);

console.log(`filter action ${wantAction}: ${order.length} rows, ${firstAt.size} distinct voxels, `
  + `${[...lastAt.values()].filter((v) => v > 0).length} voxels claimed more than once`);

// 1. the dedupe hole, at several playheads
const marks = [0.1, 0.25, 0.5, 0.75, 0.9].map((f) => Math.floor(order.length * f));
for (const K of marks) {
  const sec = tl.sec[order[K]];
  // voxels that had at least one claim at or before this playhead: the block STOOD (this filter is places)
  let stood = 0;
  for (const k of firstAt.values()) if (k <= K) stood++;
  // what a newest-claim-only layer draws by this second: markers whose own row index <= K
  let draws = 0;
  for (const k of lastAt.values()) if (k <= K) draws++;
  console.log(`  playhead row ${K} (${sec} s): ${stood} voxels have a claim this early, `
    + `newest-claim-only draws ${draws} -> ${stood - draws} stood but drew NOTHING`);
}

// 2. faces culled because of a claim that has not happened yet
let faces = 0, culled = 0, byFuture = 0, futureVoxels = new Set();
for (let k = 0; k < order.length; k++) {
  const [bx, y, wz] = keys[k].split(',').map(Number);
  for (const f of (wantAction ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5])) {
    faces++;
    const d = FACE_OFF[f];
    const nk = `${bx + d[0]},${y + d[1]},${wz + d[2]}`;
    const nf = firstAt.get(nk);
    if (nf === undefined) continue;
    culled++;
    if (nf > k) { byFuture++; futureVoxels.add(keys[k]); }
  }
}
console.log(`  face cull over the whole filter: ${faces} faces, ${culled} sit against another claim`
  + ` (${(100 * culled / faces).toFixed(1)}%), of which ${byFuture} are culled because that claim is LATER`
  + ` (${(100 * byFuture / faces).toFixed(1)}% of all faces, ${futureVoxels.size} markers affected)`);

// 3. the same question the user asks: how many markers does a newest-claim layer drop altogether
resetMarkerLift();
const a = buildTimeBlocks(tl, P, order, assets, nameIds, { grow: 1, stackGrow: 0, cull: true, dedupe: true });
resetMarkerLift();
const b = buildTimeBlocks(tl, P, order, assets, nameIds, { grow: 1, stackGrow: 0, cull: true, dedupe: false });
console.log(`  markers: dedupe ${a.stats.markers} (dropped ${a.stats.deduped}) vs every claim ${b.stats.markers}`);
console.log(`  verts: ${a.stats.verts} vs ${b.stats.verts}; index bytes ${(a.idx.byteLength + a.pos.byteLength) / 1e6
  .toFixed?.(1) ?? ((a.idx.byteLength + a.pos.byteLength) / 1e6).toFixed(1)} MB vs `
  + `${((b.idx.byteLength + b.pos.byteLength) / 1e6).toFixed(1)} MB`);
console.log(`  culled faces: ${a.stats.culled} vs ${b.stats.culled}; fully inside ${a.stats.enclosed} vs ${b.stats.enclosed}`);
