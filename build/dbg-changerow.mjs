// Which logged block changes can the camera actually see?
//
// Undoing a change only moves a pixel when the voxel it names is the top block of its column: a trampled
// grass block buried under polished diorite (measured at -45,63,-126) is a correct edit and an invisible
// one. That is why the first pixel A/B read "changed: 0" - it was framed on a buried change.
// This finds surface changes in the chunks the time machine rewrites most.
import fs from 'node:fs';
import { readPack, decodeTimeline, NCLASS } from '../shared/ledger-pack.mjs';
import path from 'node:path';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openChunk } from '../web/js/payload.js';

const DIM = 'minecraft:overworld';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const ids = buildStateIds(atlas.states.map((x) => x.k));
const stamp = Math.floor(fs.statSync(path.join('DarkRPG', 'world', 'region')).mtimeMs / 1000);
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', { stamp });
// atlas key -> bare block name, so a log name like `minecraft:grass_block` can be compared with a
// payload key like `minecraft:grass_block|snowy=false`.
const bare = (id) => (atlas.states[id - 1]?.k ?? '').split('|')[0];
const raw = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(raw);
const tl = decodeTimeline(raw.subarray(pack.tlBytes[0], pack.tlBytes[1]));

const cells = [];
for (let i = 0; i < pack.cellCount; i++) {
  const c = pack.cell(i);
  let n = 0; for (let k = 0; k < NCLASS; k++) n += c.counts[k];
  cells.push({ i, cx: c.cx, cz: c.cz, n, change: c.counts[0] });
}
cells.sort((a, b) => b.change - a.change);

const byCell = new Map();
for (let i = 0; i < tl.count; i++) {
  const c = tl.cellOf(i);
  const a = byCell.get(c); if (a) a.push(i); else byCell.set(c, [i]);
}

let shown = 0, checked = 0, chunks = 0;
for (const c of cells.slice(0, +arg('chunks', 10))) {
  const bytes = svc.chunkBytes(DIM, c.cx, c.cz);
  if (!bytes) continue;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ch = openChunk(ab);
  if (!ch) continue;
  chunks++;
  const rows = byCell.get(c.i) || [];
  const hits = [];
  for (const i of rows) {
    if (tl.action[i] !== 0) continue;                    // 0 = block-change
    const x = c.cx * 16 + tl.x(i), z = c.cz * 16 + tl.z(i), y = tl.y(i);
    checked++;
    if (ch.surfaceAt(x, z) !== y + 1) continue;          // WORLD_SURFACE sits one above the top block
    const now = bare(ch.stateAt(x, y, z) ?? 0);
    const after = tl.nameOf(i), was = tl.wasOf(i);
    if (now !== after || was === after) continue;        // undoing it must actually change what is drawn
    hits.push({ x, y, z, sec: tl.sec[i], now, was, after, cell: `${c.cx},${c.cz}`, changeRows: c.change });
  }
  for (const h of hits.slice(0, 2)) { console.log(JSON.stringify(h)); shown++; }
  if (shown >= +arg('want', 6)) break;
}
console.log(`scanned ${chunks} chunks, ${checked} change rows, ${shown} surface candidates`);
