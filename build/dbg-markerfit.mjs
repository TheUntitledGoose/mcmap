// What leaves a marker's own voxel now, and which knob did it: the grow shell, the stack ramp, or the model?
// node build/dbg-markerfit.mjs [grow] [stackGrow]
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';

const grow = +(process.argv[2] ?? 1.09);
const stackGrow = +(process.argv[3] ?? 0.36);
const dedupe = (process.argv[4] ?? '1') !== '0';
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const nameIds = stateIdsByName(assets.states);
const rows = [];
for (let i = 0; i < tl.count; i++) {
  const c = P.cell(tl.cellOf(i));
  if (c.cx === -3 && c.cz === -8 && tl.action[i] === 1) rows.push(i);
}
resetMarkerLift();
const out = buildTimeBlocks(tl, P, rows, assets, nameIds, { grow, stackGrow, cull: true, dedupe });
const { pos, idx, markerEnd, markerRow } = out;
const count = {}, maxOver = {};
let prev = 0, over = 0;
const worst = [];
for (let m = 0; m < markerEnd.length; m++) {
  const i = markerRow[m];
  const c = P.cell(tl.cellOf(i));
  const bx = c.cx * 16 + tl.x(i), y = tl.y(i), wz = c.cz * 16 + tl.z(i);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let cubeArms = 0, modelQuads = 0;
  for (let k = prev; k < markerEnd[m]; k++) {
    const p = idx[k] * 3;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], pos[p + a]); hi[a] = Math.max(hi[a], pos[p + a]);
    }
  }
  prev = markerEnd[m];
  // a cube arm's own face sits at lo/hi of the scaled cube; a model's quads may not fill it
  const o = Math.max(bx - lo[0], y - lo[1], wz - lo[2], hi[0] - (bx + 1), hi[1] - (y + 1), hi[2] - (wz + 1));
  if (o <= 0.05) continue;
  over++;
  const nm = tl.nameOf(i) || '?';
  const st = assets.states[(nameIds.get(nm) ?? 0) - 1];
  let kind;
  if (!st?.cube?.length) kind = 'model';
  else if (o > (grow - 1) / 2 + 0.01) kind = 'stack ramp';
  else kind = 'grow shell';
  count[kind] = (count[kind] ?? 0) + 1;
  maxOver[kind] = Math.max(maxOver[kind] ?? 0, o);
  if (o > 0.2) worst.push({ kind, nm, x: bx, y, z: wz, over: +o.toFixed(2) });
}
// real repeats: the same voxel claimed twice by this filter
const seen = new Map();
for (const i of rows) {
  const c = P.cell(tl.cellOf(i));
  const k = `${c.cx * 16 + tl.x(i)},${tl.y(i)},${c.cz * 16 + tl.z(i)}`;
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const rep = [...seen.values()].filter((n) => n > 1);
console.log(`grow ${grow} stackGrow ${stackGrow} dedupe ${dedupe}: cells -3,-8, place rows ${rows.length}`);
console.log(`  claims ${markerRow.length} distinct voxels ${seen.size} voxels claimed more than once ${rep.length} deepest ${Math.max(...seen.values())}`);
console.log(`  markers whose geometry leaves its voxel by >0.05 blocks: ${over} of ${markerRow.length}`);
for (const k of Object.keys(count)) console.log(`  ${k}: ${count[k]} markers, worst ${maxOver[k].toFixed(2)} blocks past the voxel`);
worst.sort((a, b) => b.over - a.over);
for (const w of worst.slice(0, 12)) console.log(`  ${w.kind} ${w.nm} at ${w.x},${w.y},${w.z} over ${w.over}`);
console.log(`  index ${idx.length} tris ${idx.length / 3} pos bytes ${pos.byteLength / 1e6} MB`);
