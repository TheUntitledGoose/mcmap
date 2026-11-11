// Where does a wall of green blocks come from? Find the densest placement cell in the shipped overworld
// pack, build its markers the way main.js does, and measure what a marker cube actually covers.
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

// Rows with a hand behind them that placed something.
const place = [];
for (let i = 0; i < tl.count; i++) if (tl.action[i] === 1) place.push(i);
const vox = new Set();
for (const i of place) {
  const c = P.cell(tl.cellOf(i));
  vox.add(`${c.cx},${c.cz}`);
}
console.log('place rows', place.length, 'cells with a placement', vox.size);

// Densest chunk by distinct claimed voxels, and the block names there.
const perCell = new Map();
for (const i of place) {
  const c = P.cell(tl.cellOf(i));
  const k = c.cx + ',' + c.cz;
  let e = perCell.get(k);
  if (!e) { e = { c, set: new Set(), names: new Map() }; perCell.set(k, e); }
  e.set.add(tl.y(i) * 256 + tl.x(i) * 16 + tl.z(i));
  const n = tl.nameOf(i);
  e.names.set(n, (e.names.get(n) ?? 0) + 1);
}
const top = [...perCell.values()].sort((a, b) => b.set.size - a.set.size).slice(0, 4);
for (const e of top) {
  const names = [...e.names].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, k]) => `${k}x ${n}`).join(', ');
  console.log(`cell ${e.c.cx},${e.c.cz}  world x ${e.c.cx * 16}..${e.c.cx * 16 + 15} z ${e.c.cz * 16}..${e.c.cz * 16 + 15}  voxels ${e.set.size}  ${names}`);
}

const e = top[0];
const rows = place.filter((i) => {
  const c = P.cell(tl.cellOf(i));
  return c.cx === e.c.cx && c.cz === e.c.cz;
});
for (const combo of [{ stackGrow: 0, cull: false }, { stackGrow: 0.36, cull: false }, { stackGrow: 0.36, cull: true }]) {
  const { stackGrow, cull } = combo;
  resetMarkerLift();
  const out = buildTimeBlocks(tl, P, rows, assets, stateIdsByName(assets.states),
    { plates: false, grow: 1 + 2 * 0.09, stackGrow, cull });
  const { pos, idx, markerEnd, markerRow } = out;
  // Per-marker AABB from its own index range.
  let maxOver = 0; const overHist = [0, 0, 0, 0]; const byKind = { cube: [0, 0, 0, 0], model: [0, 0, 0, 0] };
  const worst = new Map();
  let prev = 0;
  const nameIds = stateIdsByName(assets.states);
  for (let m = 0; m < markerEnd.length; m++) {
    const i = markerRow[m];
    const c = P.cell(tl.cellOf(i));
    const bx = c.cx * 16 + tl.x(i), y = tl.y(i), wz = c.cz * 16 + tl.z(i);
    let lox = Infinity, loy = Infinity, loz = Infinity, hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
    for (let k = prev; k < markerEnd[m]; k++) {
      const p = idx[k] * 3;
      lox = Math.min(lox, pos[p]); hix = Math.max(hix, pos[p]);
      loy = Math.min(loy, pos[p + 1]); hiy = Math.max(hiy, pos[p + 1]);
      loz = Math.min(loz, pos[p + 2]); hiz = Math.max(hiz, pos[p + 2]);
    }
    prev = markerEnd[m];
    const over = Math.max(bx - lox, loy - y, wz - loz, hix - (bx + 1), hiy - (y + 1), hiz - (wz + 1));
    maxOver = Math.max(maxOver, over);
    const q = over <= 0.1 ? 0 : over <= 0.2 ? 1 : over <= 0.5 ? 2 : 3;
    overHist[q]++;
    const nm = tl.nameOf(i) || '?';
    const sid = nameIds.get(nm);
    const st = sid ? sid - 1 : -1;
    const kind = st >= 0 && assets.states[st]?.cube?.length ? 'cube' : 'model';
    byKind[kind][q]++;
    if (over > 0.5) worst.set(nm, Math.max(worst.get(nm) ?? 0, over));
    if (over > 1.2 && worst.size < 6) {
      console.log(`    off-grid ${nm} at ${bx},${y},${wz} span ${over.toFixed(2)} blocks beyond its voxel`);
    }
  }
  // How many marker faces sit against another claimed voxel of the same filter.
  const claimed = new Set(rows.map((i) => {
    const c = P.cell(tl.cellOf(i));
    return (c.cx * 16 + tl.x(i)) + ',' + tl.y(i) + ',' + (c.cz * 16 + tl.z(i));
  }));
  const DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  let shared = 0, total = 0, withNeighbour = 0;
  for (const i of rows) {
    const c = P.cell(tl.cellOf(i));
    const bx = c.cx * 16 + tl.x(i), y = tl.y(i), wz = c.cz * 16 + tl.z(i);
    let n = 0;
    for (const [dx, dy, dz] of DIRS) {
      total++;
      if (claimed.has((bx + dx) + ',' + (y + dy) + ',' + (wz + dz))) { shared++; n++; }
    }
    if (n) withNeighbour++;
  }
  console.log(`stackGrow ${stackGrow} cull ${cull ? 'on ' : 'off'}: markers ${out.stats.markers} cubes ${out.stats.cubes} models ${out.stats.models} faces ${out.stats.faces} culled ${out.stats.culled} fullyInside ${out.stats.enclosed} tris ${out.stats.tris} MB ${(out.stats.bytes / 1048576).toFixed(2)} maxStack ${out.stats.maxStack}`);
  console.log(`  overhang beyond its own voxel: max ${maxOver.toFixed(3)} blocks, <=0.1 ${overHist[0]}, 0.1-0.2 ${overHist[1]}, 0.2-0.5 ${overHist[2]}, >0.5 ${overHist[3]}`);
  console.log(`  by kind  cube: ${byKind.cube.join('/')}  model: ${byKind.model.join('/')}`);
  console.log(`  worst offenders: ${[...worst].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => `${v.toFixed(2)} ${n}`).join(', ')}`);
  console.log(`  faces against a claimed neighbour: ${shared} of ${total} (${(100 * shared / total).toFixed(0)}%), markers with any claimed neighbour ${withNeighbour} of ${rows.length}`);
}
