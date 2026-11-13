// "Some blocks are being skipped entirely." How many, and which rule is responsible?
//
// For each of the two cull rules and both dedupe settings, ask the question a person watching the time
// machine asks at a mid-log second: of the voxels this filter had already claimed by now, how many have NO
// marker at or before this second, i.e. draw nothing at all? And separately, how many faces were thrown away
// because a neighbour's claim is LATER than the face being drawn?
//
// node build/dbg-timehonest.mjs [actionClass: 0=any 1=break 2=place]
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';

const wantAction = +(process.argv[2] ?? 0);
const FILE = 'build/ledger/region.ledpack';
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const buf = fs.readFileSync(FILE);
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const nameIds = stateIdsByName(assets.states);

const order = [];
for (let i = 0; i < tl.count; i++) if (tl.action[i] === wantAction || wantAction === 0) order.push(i);
const key = (i) => { const c = P.cell(tl.cellOf(i)); return `${c.cx * 16 + tl.x(i)},${tl.y(i)},${c.cz * 16 + tl.z(i)}`; };
const keys = order.map(key);
const firstIdx = new Map();                       // voxel -> earliest filter position claiming it
for (let k = 0; k < order.length; k++) if (!firstIdx.has(keys[k])) firstIdx.set(keys[k], k);
const mb = (n) => (n / 1048576).toFixed(1);
const marks = [0.1, 0.25, 0.5, 0.75, 0.9].map((f) => Math.floor(order.length * f));
console.log(`${FILE}: filter action ${wantAction}, ${order.length} rows, `
  + `${firstIdx.size} distinct voxels`);

for (const [label, opts] of [
  ['SHIPPED: whole-filter cull + newest claim only', { cull: 2, dedupe: true }],
  ['NEW: cull as of the claim, every claim draws', { cull: 1, dedupe: false }],
]) {
  resetMarkerLift();
  const b = buildTimeBlocks(tl, P, order, assets, nameIds, { grow: 1, stackGrow: 0, ...opts });
  const s = b.stats;
  console.log(`\n${label}`);
  console.log(`  markers ${s.markers}  faces ${s.faces}  culled ${s.culled}  inside ${s.enclosed}`
    + `  deduped ${s.deduped}  verts ${s.verts}  MB ${mb(s.bytes)}`);
  // Which second does each drawn marker belong to, and which voxel? Walk the build's own arrays.
  const rowsOf = Array.from(b.markerRow);
  // Two honest reasons a standing voxel can draw nothing: the atlas has no shape for the name the log gives
  // (a block the players later re-skinned away, so it is in no census), or every one of its six sides was
  // already claimed at that second, which makes it inside the players' own build. Anything else is the bug.
  const unknown = new Set();
  for (const [vox, k] of firstIdx) {
    const name = tl.nameOf(order[k]);
    const st = name ? (nameIds.get(name) ?? 0) - 1 : -1;
    if (st < 0 || st >= assets.states.length) unknown.add(vox);   // the builder's own test, line for line
  }
  for (const K of marks) {
    const sec = tl.sec[order[K]];
    let stood = 0;
    for (const k of firstIdx.values()) if (k <= K) stood++;
    const drawnVoxels = new Set();
    for (let m = 0; m < rowsOf.length; m++) if (rowsOf[m] <= order[K]) drawnVoxels.add(key(rowsOf[m]));
    let missing = 0, noShape = 0;
    for (const [vox, k] of firstIdx) {
      if (k > K || drawnVoxels.has(vox)) continue;
      missing++;
      if (unknown.has(vox)) noShape++;
    }
    console.log(`  playhead ${K} (${sec} s): ${stood} voxels stand by now, `
      + `${stood - missing} of them draw something -> ${missing} SKIPPED `
      + `(${noShape} have no model in this atlas, ${missing - noShape} enclosed inside the build)`);
  }
}
