/**
 * Which log claims name a block this atlas has no shape for, and where they sit.
 *
 * An unknown name is not dropped quietly: the count goes in the note and the voxel draws a stand-in. But a
 * magenta blob the size of a room reads as "your renderer is broken", so the page has to be able to NAME the
 * block. This lists the names behind `stats.unknown`, with the cells and levels they occupy, for one filter.
 *
 *   node build/dbg-unknownnames.mjs [action]     // 1 = place, 2 = break; default place
 */
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';

const want = +(process.argv[2] ?? 1);
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const byName = stateIdsByName(assets.states);

const per = new Map();
let rows = 0, unknown = 0, air = 0;
for (let i = 0; i < tl.count; i++) {
  if (tl.action[i] !== want) continue;
  rows++;
  const name = tl.nameOf(i);
  const st = name ? (byName.get(name) ?? 0) - 1 : -1;
  if (st >= 0 && st < assets.states.length) {
    if (assets.stateAir[st] === 1) air++;
    continue;
  }
  unknown++;
  const c = P.cell(tl.cellOf(i));
  const e = per.get(name || '(no name)') ?? { n: 0, cells: new Map(), lo: 1e9, hi: -1e9 };
  e.n++;
  const ck = `${c.cx},${c.cz}`;
  e.cells.set(ck, (e.cells.get(ck) ?? 0) + 1);
  e.lo = Math.min(e.lo, tl.y(i)); e.hi = Math.max(e.hi, tl.y(i));
  per.set(name || '(no name)', e);
}

const act = want === 1 ? 'place' : 'break';
console.log(`${act} rows ${rows.toLocaleString()}; named something the atlas has no state for ${unknown.toLocaleString()}`
  + ` (${(100 * unknown / Math.max(1, rows)).toFixed(2)}%); air-named ${air.toLocaleString()}`);
const list = [...per.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [name, e] of list.slice(0, 30)) {
  const top = [...e.cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${k} x${n}`).join(', ');
  console.log(`  ${String(e.n).padStart(6)}x ${name}`
    + `  y ${e.lo}..${e.hi}  in ${e.cells.size} cell(s): ${top}`);
}
const atlasHas = (n) => assets.states.some((s) => (s?.name ?? s?.key) === n);
console.log('does the atlas carry a state of that plain name at all?');
for (const [name] of list.slice(0, 12)) console.log(`  ${atlasHas(name) ? 'yes  ' : 'no   '} ${name}`);
