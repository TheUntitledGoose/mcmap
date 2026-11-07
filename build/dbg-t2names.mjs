// Does the ledger's name column describe the world the page holds?
//
// Tier 2 (terrain as of T) works by undoing rows newer than the playhead against the payload the
// browser already has: a break puts a block back, a place takes one away. That only holds if the log's
// coordinates land on the block it claims and if `old_object_id` names a block the state table knows.
// Neither is obvious from the schema, so this measures it over real chunks before any mesh code is
// written:
//
//   newest-row-per-voxel checks - what the log says the last action left behind, against what the
//   payload says is there now. A break whose voxel is still standing is either a re-place (fine, and
//   counted) or a coordinate mismatch (not fine).
//   name coverage - how many names resolve to a state id in the atlas table, and how many are not
//   blocks at all.
//
//   node build/dbg-t2names.mjs --cx -3 --cz -8 [--n 12] [--sample 40]
import fs from 'node:fs';
import path from 'node:path';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { readLedger } from '../shared/ledger-format.mjs';
import { readPack, decodeTimeline, tlX, tlY, tlZ, NCLASS } from '../shared/ledger-pack.mjs';
import { openChunk } from '../web/js/payload.js';
import { sectionIndex, voxelId } from '../web/js/lookup.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'DarkRPG');
const world = path.join(ROOT, 'world');
const st = fs.statSync(path.join(world, 'region'));
const stamp = Math.floor(st.mtimeMs / 1000);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const states = atlas.states;
// The payload's global state ids are 1-based indices into this exact order, so the audit has to build
// the table the same way the server does or every name check below is off by one.
const ids = buildStateIds(states.map((x) => x.k));
const svc = new WorldService(world, ids, 'build/cache', { stamp });
const DIM = 'minecraft:overworld';
// name -> the state id the renderer would use for it. The atlas table keys carry properties; the log
// names usually do not, so match on the bare name and prefer the variant with the fewest properties,
// which is the block's default form.
const byName = new Map();
states.forEach((s, i) => {
  const at = s.k.indexOf('|');
  const name = at < 0 ? s.k : s.k.slice(0, at);
  const props = at < 0 ? 0 : s.k.split('|').length - 1;
  const cur = byName.get(name);
  if (!cur || props < cur.props) byName.set(name, { id: i + 1, props });
});
const stateName = (id) => {
  if (!id) return null;
  const k = states[id - 1]?.k ?? '';
  const at = k.indexOf('|');
  return at < 0 ? k : k.slice(0, at);
};
// The timeline stores the action as `aid - 1` (6 = an action id outside the six), so translate once.
const aidOf = (b) => (b >= 6 ? 0 : b + 1);

const logBuf = fs.readFileSync('build/ledger/actions.bin');
const L = readLedger(logBuf);
const raw = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(raw);
const tl = decodeTimeline(raw.subarray(pack.tlBytes[0], pack.tlBytes[1]));
const cellOf = new Map();
for (let i = 0; i < pack.cellCount; i++) { const c = pack.cell(i); cellOf.set(`${c.cx},${c.cz}`, i); }

const wantN = +arg('n', 12);
const sample = +arg('sample', 40);
const base = tl.timeBaseSec;

// Which chunks to look at: the ones with the most rows, so the answer is about the chunks the time
// machine will actually rewrite.
const cells = [];
for (let i = 0; i < pack.cellCount; i++) {
  const c = pack.cell(i);
  let n = 0; for (let k = 0; k < NCLASS; k++) n += c.counts[k];
  cells.push({ i, cx: c.cx, cz: c.cz, n });
}
cells.sort((a, b) => b.n - a.n);
const chosen = cells.slice(0, wantN);

const stat = {
  chunks: 0, rows: 0, voxels: 0, breakRows: 0, placeRows: 0, otherRows: 0,
  namedRows: 0, unknownName: 0, nameMissing: new Map(), nameHits: new Map(),
  breakAirOk: 0, breakStillThere: 0, breakStillSame: 0,
  placePresent: 0, placeAbsent: 0, placeOther: 0,
  msPatch: 0, msMesh: 0,
};
const seenNames = new Map();

for (const c of chosen) {
  const bytes = svc.chunkBytes(DIM, c.cx, c.cz);
  if (!bytes) continue;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const ch = openChunk(ab);
  const secOf = sectionIndex(ch);
  stat.chunks++;
  // rows of this cell, ascending
  const rows = [];
  for (let k = 0; k < tl.count; k++) if (tl.cell[k] === c.i) rows.push(k);
  // (slow scan, but this is a one-shot audit over the loudest chunks; the browser builds the same
  // index in one pass instead.)
  stat.rows += rows.length;
  const newest = new Map();      // packed coord -> latest timeline row index
  for (const k of rows) {
    const x = tlX(tl.coord[k]), y = tlY(tl.coord[k]), z = tlZ(tl.coord[k]);
    newest.set(`${x},${y},${z}`, k);
    const a = tl.action[k];
    const aid = aidOf(a);
    if (aid === 2) stat.placeRows++; else if (aid === 3) stat.breakRows++; else stat.otherRows++;
    const nm = tl.nameOf(k);
    if (nm) { stat.namedRows++; seenNames.set(nm, (seenNames.get(nm) ?? 0) + 1); }
  }
  for (const [key, k] of newest) {
    const [x, y, z] = key.split(',').map(Number);
    stat.voxels++;
    const id = voxelId(ch, secOf, x, y, z);
    const present = stateName(id);
    const nm = tl.nameOf(k);
    const a = tl.action[k];
    if (nm && !byName.has(nm)) {
      stat.unknownName++;
      stat.nameMissing.set(nm, (stat.nameMissing.get(nm) ?? 0) + 1);
    }
    if (aidOf(a) === 3) {
      if (!id || id === 1) stat.breakAirOk++;
      else if (present === nm) stat.breakStillSame++;
      else stat.breakStillThere++;
    } else if (aidOf(a) === 2) {
      if (present === nm) stat.placePresent++;
      else if (!id || id === 1) stat.placeAbsent++;
      else stat.placeOther++;
    }
  }
  if (stat.chunks === 1) {
    // Sample the actual names of the loudest chunk so the answer is legible, not just counts.
    const top = [...seenNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, sample);
    console.log(`chunk ${c.cx},${c.cz}: ${rows.length} rows, ${stat.voxels} voxels`);
    for (const [nm, n] of top) {
      console.log(`  ${String(n).padStart(5)}  ${nm}${byName.has(nm) ? '' : '   <-- NOT IN THE STATE TABLE'}`);
    }
  }
}

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
console.log(`\n${stat.chunks} chunks, ${stat.rows} rows, ${stat.voxels} distinct voxels`);
console.log(`rows by kind: place ${stat.placeRows}  break ${stat.breakRows}  other ${stat.otherRows}`);
console.log(`rows naming a block: ${stat.namedRows} of ${stat.rows} (${pct(stat.namedRows, stat.rows)})`);
console.log(`names missing from the atlas state table: ${stat.unknownName} rows`);
console.log(`\nnewest-row checks (what the log says should be there now, vs the payload):`);
console.log(`  break -> voxel is air/absent   ${stat.breakAirOk}  (${pct(stat.breakAirOk, stat.breakRows)})`);
console.log(`  break -> voxel holds something else (replaced later) ${stat.breakStillThere}`);
console.log(`  break -> voxel still holds THAT block (bad) ${stat.breakStillSame}  (${pct(stat.breakStillSame, stat.breakRows)})`);
console.log(`  place -> voxel holds that block   ${stat.placePresent}  (${pct(stat.placePresent, stat.placeRows)})`);
console.log(`  place -> voxel is air (broken later) ${stat.placeAbsent}`);
console.log(`  place -> voxel holds something else ${stat.placeOther}`);
const miss = [...stat.nameMissing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (miss.length) {
  console.log(`\ntop names the renderer has no state for:`);
  for (const [nm, n] of miss) console.log(`  ${String(n).padStart(5)}  ${nm}`);
}
