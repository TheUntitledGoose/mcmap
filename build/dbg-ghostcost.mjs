// What does a block-shaped change marker cost? Same builder the page will use, real atlas, real timeline,
// no GPU: it prints quads, vertices, index bytes and milliseconds per look, per filter.
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { filterRows } from '../web/js/ledger-time.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const byName = stateIdsByName(atlas.states);

const packFile = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(packFile);
const tl = decodeTimeline(ab(packFile.subarray(pack.tlBytes[0], pack.tlBytes[1])));
console.log('timeline v' + tl.version, 'rows', tl.count.toLocaleString(), 'cells', pack.cellCount);

let placeholder = 0;
for (const t of assets.textures) if (t.kind === 3) placeholder++;
console.log('atlas states', assets.states.length, 'placeholder sprite cells', placeholder);

const CLS = { 0: 'any change', 2: 'block place', 3: 'block break' };
for (const cls of [2, 0, 3]) {
  const got = filterRows(tl, { who: 0, cls, limit: 0 });
  for (const mode of ['cubes', 'plates']) {
    resetMarkerLift();
    const t0 = performance.now();
    const out = buildTimeBlocks(tl, pack, got.order, assets, byName, { plates: mode === 'plates' });
    const ms = performance.now() - t0;
    const s = out.stats;
    console.log(
      `${CLS[cls].padEnd(11)} ${mode.padEnd(6)} rows ${s.rows.toLocaleString().padStart(7)}`
      + ` markers ${s.markers.toLocaleString().padStart(7)}`
      + ` cubes ${s.cubes.toLocaleString().padStart(7)} plates ${s.plates.toLocaleString().padStart(7)}`
      + ` models ${s.models.toLocaleString().padStart(6)}`
      + ` unknown ${s.unknown.toLocaleString().padStart(6)} air ${s.air}`
      + ` | quads ${s.quads.toLocaleString().padStart(8)} verts ${s.verts.toLocaleString().padStart(9)}`
      + ` idx ${out.idx ? out.idx.byteLength : 0} B geo ${s.bytes.toLocaleString().padStart(11)} B`
      + ` | ${ms.toFixed(0)} ms`);
  }
}

// Which names the atlas cannot draw - the number the panel has to be honest about.
const miss = new Map();
{
  const got = filterRows(tl, { who: 0, cls: 0, limit: 0 });
  for (const i of got.order) {
    const nm = tl.nameOf(i);
    if (nm && !byName.get(nm)) miss.set(nm, (miss.get(nm) ?? 0) + 1);
  }
}
const top = [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('names the atlas cannot draw:', miss.size, top.map(([k, v]) => `${k}=${v}`).join(' '));
