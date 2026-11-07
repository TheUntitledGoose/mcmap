// M12: does a ledger row still describe the world we render? The log's ActionIdentifiers table labels
// its action numbers (block-change / block-place / block-break / ...) but a label is worth nothing
// until it is checked against voxels: a "placed X" claim is only true if the world still holds X at
// that coordinate. This reads the payload the same way the browser does and grades each row.
//
//   node build/dbg-ledger-truth.mjs [--chunks 40] [--dim minecraft:overworld] [--all]
import { readFileSync } from 'node:fs';
import { openChunk } from '../web/js/payload.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { ACTION_NAME, formatLedgerTime, readLedger } from '../shared/ledger-format.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const wantDim = flag('dim', 'minecraft:overworld');
const maxChunks = +flag('chunks', 40);
const takeAll = argv.includes('--all');

const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const keyOf = (id) => (id ? atlas.states[id - 1]?.k ?? `id:${id}` : '<unknown state>');
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), 'build/cache', {});

const L = readLedger(readFileSync('build/ledger/actions.bin'));
const dimId = [...L.worlds].find(([, w]) => w.id === wantDim)?.[0];
if (dimId === undefined) {
  throw new Error(`no ledger world named ${wantDim}; have: ${[...L.worlds].map(([, w]) => w.id).join(', ')}`);
}

// Group this dimension's rows by chunk: a chunk payload is the unit the world can be read in.
const byChunk = new Map();
for (let i = 0; i < L.count; i++) {
  if (L.worldId(i) !== dimId) continue;
  const k = (L.x(i) >> 4) + ',' + (L.z(i) >> 4);
  const a = byChunk.get(k);
  if (a) a.push(i); else byChunk.set(k, [i]);
}
const order = [...byChunk].sort((a, b) => b[1].length - a[1].length);
const half = Math.ceil(maxChunks / 2);
const picked = takeAll ? order : order.slice(0, half)
  // Half the sample from the busiest chunks (what an overlay would actually paint), half from the
  // quiet tail (what most of the world looks like). One or the other alone flatters the result.
  .concat(order.filter(([, rows]) => rows.length <= 3).slice(0, maxChunks - half));

const grade = new Map();     // action id -> Map(class -> count)
const examples = new Map();  // action id -> a few human-readable mismatches
const bump = (aid, cls) => {
  let m = grade.get(aid);
  if (!m) grade.set(aid, m = new Map());
  m.set(cls, (m.get(cls) ?? 0) + 1);
};

let loaded = 0, absent = 0, graded = 0;
for (const [k, rows] of picked) {
  const [cx, cz] = k.split(',').map(Number);
  const buf = await svc.chunkBytes(wantDim, cx, cz);
  if (!buf) { absent += rows.length; continue; }
  const c = openChunk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 0);
  loaded++;
  for (const i of rows) {
    const y = L.y(i);
    const obj = L.objects.get(L.objectId(i))?.id ?? '';
    let cls, voxel = '';
    if ((y >> 4) < c.yMin || (y >> 4) >= c.yMin + c.yCount || !c.sectionAt(y)) {
      cls = 'outside stored range';
    } else {
      voxel = keyOf(c.stateAt(L.x(i) & 15, y, L.z(i) & 15));
      const base = voxel.split('|')[0];
      cls = base === obj ? 'same block now' : base === 'minecraft:air' ? 'air now' : 'other';
    }
    bump(L.actionId(i), cls);
    graded++;
    if (cls === 'other') {
      const ex = examples.get(L.actionId(i)) ?? [];
      if (ex.length < 3) {
        ex.push(`${obj} @ ${L.x(i)},${L.y(i)},${L.z(i)} on ${formatLedgerTime(L.timeMs(i))} ` +
          `(${L.players.get(L.playerId(i))?.name ?? 'no player'}) -> world holds ${voxel}`);
        examples.set(L.actionId(i), ex);
      }
    }
  }
}

console.log(`\n${wantDim}: ${byChunk.size} chunks hold ledger rows, ${loaded} chunks read, ` +
  `${graded} rows graded` + (absent ? `, ${absent} rows sit in chunks this world does not have` : ''));
for (const [aid, m] of [...grade].sort((a, b) =>
  [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const total = [...m.values()].reduce((x, y) => x + y, 0);
  console.log(`${L.actions.get(aid)?.id ?? aid} (id ${aid}): ` +
    [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} (${Math.round(100 * n / total)}%)`).join(', '));
  for (const ex of examples.get(aid) ?? []) console.log('    ' + ex);
}
