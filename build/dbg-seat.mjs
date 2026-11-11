// M15 seat, measured: does "feet on the first solid block under the block the hand touched" hold up
// against the real voxels, and how jumpy is that answer while the playhead moves?
//
// seatOf (shared/ghosts.mjs) has one job: turn a logged action's block into a place to stand. Its rule
// is one line and could easily be wrong in a way that only shows on real terrain - a body floating over
// a mine, or a body snapping five blocks up and down between two actions. This asks it against the
// region data and the real asset collision table.
//
//   node build/dbg-seat.mjs                      # 300 sampled hand rows per player, overworld
//   node build/dbg-seat.mjs --dim=minecraft:the_nether --n=400
import { readFileSync } from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { presenceOf, seatOf, handRows } from '../shared/ghosts.mjs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { C_FULL } from '../shared/player.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DIM = arg('dim', 'minecraft:overworld');
const N = +arg('n', 300);
const FILE = {
  'minecraft:overworld': 'build/ledger/region.ledpack',
  'minecraft:the_nether': 'build/ledger/DIM-1_region.ledpack',
  'minecraft:the_end': 'build/ledger/DIM1_region.ledpack',
}[DIM];
const names = JSON.parse(readFileSync('build/ledger/meta.json', 'utf8')).players;
const nameOf = (i) => names[i]?.name ?? `#${i + 1}`;

const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const geo = readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

const buf = readFileSync(FILE);
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const worldOf = (i) => P.cell(i);
const pres = presenceOf(tl, { worldOf });

// The voxels, one chunk at a time, held in a Map so a sample in the same chunk is free. Chunks are
// fetched through the same service the page talks to, so "solid" here is the same answer the page gives.
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), 'build/cache', {});
const held = new Map();
const chunkAt = (cx, cz) => {
  const k = `${cx},${cz}`;
  if (held.has(k)) return held.get(k);
  let ch = null;
  const bytes = svc.chunkBytes(DIM, cx, cz);
  if (bytes) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try { ch = openChunk(ab); } catch { ch = null; }
  }
  held.set(k, ch);
  return ch;
};
const cellAt = makeCellAt(chunkAt, () => assets);
const solid = (x, y, z) => cellAt(x, y, z) === C_FULL;

const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);
const hist = (arr) => {
  if (!arr.length) return 'none';
  const c = new Map();
  for (const v of arr) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([v, n]) => `${v}:${(100 * n / arr.length).toFixed(0)}%`).join(' ');
};

console.log(`${DIM}: hand rows ${pres.handRows}; sampling ${N} per player against real region data`);
const allSeat = [], allJump = [], allActed = [];
// How far down to look for a floor is a constant in shared/ghosts.mjs, so the sweep is printed here
// rather than guessed at: a mine floor six blocks under a picked block is still a floor.
const LOOKS = [4, 8, 12];
const lookSeat = LOOKS.map(() => []);
for (const p of pres.players) {
  const rows = handRows(tl, p.player);
  const step = Math.max(1, Math.floor(rows.length / N));
  const seats = [], jumps = [], acted = [];
  let missing = 0;
  LOOKS.forEach((L, li) => {
    for (let j = 0; j < rows.length; j += step) {
      const r = rows[j];
      lookSeat[li].push(seatOf(tl, r, { solid, look: L, worldOf }).seat);
    }
  });
  for (let j = 0; j < rows.length; j += step) {
    const r = rows[j];
    const s = seatOf(tl, r, { solid, worldOf });
    if (!chunkAt(s.x >> 4, s.z >> 4)) missing++;
    seats.push(s.seat);
    // How far the acted block sits above the floor: 0 means the hand touched the floor block itself.
    acted.push(s.floor === null ? NaN : tl.y(r) - s.floor);
    const c = worldOf(tl.cell[r]);
    allSeat.push(s.seat);
    allActed.push(tl.y(r) - s.floor);
  }
  // Jump between the seats of CONSECUTIVE actions inside the same visit: that is what a scrubbing
  // playhead would show, and a body snapping up and down is the failure this has to price.
  for (let j = 1; j < rows.length; j++) {
    const a = rows[j - 1], b = rows[j];
    const ca = worldOf(tl.cell[a]), cb = worldOf(tl.cell[b]);
    const sa = seatOf(tl, a, { solid, worldOf }), sb = seatOf(tl, b, { solid, worldOf });
    if (Math.abs(sa.x - sb.x) + Math.abs(sa.z - sb.z) > 24) continue;   // different visit-ish: skip
    jumps.push(Math.abs(sa.y - sb.y));
    allJump.push(Math.abs(sa.y - sb.y));
  }
  const dxy = [];
  for (let j = 1; j < rows.length; j++) {
    const a = rows[j - 1], b = rows[j];
    const pa = { x: worldOf(tl.cell[a]).cx * 16 + tl.x(a), z: worldOf(tl.cell[a]).cz * 16 + tl.z(a) };
    const pb = { x: worldOf(tl.cell[b]).cx * 16 + tl.x(b), z: worldOf(tl.cell[b]).cz * 16 + tl.z(b) };
    dxy.push(Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.z - pb.z)));
  }
  console.log(`  ${nameOf(p.player).padEnd(14)} seats ${hist(seats)}  ` +
    `acted-floor p50 ${q(acted.filter(Number.isFinite), 0.5)} p90 ${q(acted.filter(Number.isFinite), 0.9)}  ` +
    `seat jump p50 ${q(jumps, 0.5)} p90 ${q(jumps, 0.9)} max ${Math.max(0, ...jumps)}  ` +
    `step p50 ${q(dxy, 0.5)} p90 ${q(dxy, 0.9)}  no chunk for ${missing}`);
}
const act = allActed.filter(Number.isFinite);
console.log(`\nALL: seats ${hist(allSeat)}`);
for (let li = 0; li < LOOKS.length; li++) {
  const h = hist(lookSeat[li]);
  console.log(`  look ${String(LOOKS[li]).padStart(2)} blocks below: ${h}`);
}
console.log(`  acted block above its floor: p50 ${q(act, 0.5)} p90 ${q(act, 0.9)} max ${Math.max(...act)}`);
console.log(`  seat Y jump between neighbouring actions in place: p50 ${q(allJump, 0.5)} ` +
  `p90 ${q(allJump, 0.9)} p99 ${q(allJump, 0.99)}`);
console.log(`  chunks opened for ${N * pres.players.length} samples: ${held.size}, ` +
  `of which missing from the save: ${[...held.values()].filter((c) => !c).length}`);
svc.close?.();
