// Which marker geometry leaves its own voxel, and is it the cube or the model that does it?
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const nameIds = stateIdsByName(assets.states);
const place = [];
for (let i = 0; i < tl.count; i++) if (tl.action[i] === 1) place.push(i);
const rows = place.filter((i) => {
  const c = P.cell(tl.cellOf(i));
  return c.cx === -3 && c.cz === -8;
});
resetMarkerLift();
const out = buildTimeBlocks(tl, P, rows, assets, nameIds,
  { grow: 1.18, stackGrow: 0.36, cull: true });
const { pos, idx, markerEnd, markerRow } = out;
let prev = 0;
for (let m = 0; m < markerEnd.length; m++) {
  const i = markerRow[m];
  const c = P.cell(tl.cellOf(i));
  const bx = c.cx * 16 + tl.x(i), y = tl.y(i), wz = c.cz * 16 + tl.z(i);
  let lo, hi, lo2 = [Infinity, Infinity, Infinity], hi2 = [-Infinity, -Infinity, -Infinity];
  const i0 = prev;
  for (let k = prev; k < markerEnd[m]; k++) {
    const p = idx[k] * 3;
    for (let a = 0; a < 3; a++) {
      lo2[a] = Math.min(lo2[a], pos[p + a]); hi2[a] = Math.max(hi2[a], pos[p + a]);
    }
  }
  prev = markerEnd[m];
  const over = Math.max(bx - lo2[0], y - lo2[1], wz - lo2[2],
    hi2[0] - (bx + 1), hi2[1] - (y + 1), hi2[2] - (wz + 1));
  if (over > 0.5) {
    const nm = tl.nameOf(i) || '?';
    const st = (nameIds.get(nm) ?? 0) - 1;
    const s = assets.states[st];
    console.log(`${nm} at ${bx},${y},${wz} idx ${markerEnd[m] - i0} over ${over.toFixed(2)}`);
    console.log(`  cube arms ${s?.cube?.length ?? 0} model quads ${s?.g?.[0]?.length ?? 0}`);
    console.log(`  aabb x ${lo2[0].toFixed(2)}..${hi2[0].toFixed(2)} y ${lo2[1].toFixed(2)}..${hi2[1].toFixed(2)} z ${lo2[2].toFixed(2)}..${hi2[2].toFixed(2)}`);
  }
}
