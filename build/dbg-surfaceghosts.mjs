// M15 bodies, underground or in the open: how deep below the open sky does a logged hand action put a person?
//
// The page now says "N of those stand below the open sky, the lowest at y X" in the people note, because at
// the second the overworld log supports the most people at once every one of them is deep in a mine - and
// with the caves toggle off the rock they stand in is not drawn, which looks like a floating name tag.
// That sentence needs a measured distribution, and a browser screenshot needs a moment where somebody
// actually stood outside. Both come from the region bytes, not from a guess.
//
//   node build/dbg-surfaceghosts.mjs                       # overworld, 400 sampled hand rows per player
//   node build/dbg-surfaceghosts.mjs --dim=minecraft:the_nether
import { readFileSync } from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { presenceOf, seatOf, handRows, bodiesAt } from '../shared/ghosts.mjs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { makeCellAt } from '../web/js/collision.js';
import { C_FULL } from '../shared/player.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DIM = arg('dim', 'minecraft:overworld');
const N = +arg('n', 400);
const FILE = {
  'minecraft:overworld': 'build/ledger/region.ledpack',
  'minecraft:the_nether': 'build/ledger/DIM-1_region.ledpack',
  'minecraft:the_end': 'build/ledger/DIM1_region.ledpack',
}[DIM];
const meta = JSON.parse(readFileSync('build/ledger/meta.json', 'utf8'));
const nameOf = (i) => meta.players[i]?.name ?? `#${i + 1}`;

const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const geo = readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));

const buf = readFileSync(FILE);
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
const worldOf = (i) => P.cell(i);
const pres = presenceOf(tl, { worldOf });

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
/**
 * Could you see this person from outside? Their own two cells empty and three of the four sides open: a
 * player standing inside their own treehouse obeys walls exactly, and is therefore invisible from any
 * framing that is not inside it too.
 */
const inTheOpen = (x, y, z) => !solid(x, y, z) && !solid(x, y + 1, z)
  && [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => !solid(x + dx, y, z + dz)).length >= 3;
// WORLD_SURFACE of the column the body stands in: the same number the page's surfaceTop() reads.
const skyOf = (x, z) => {
  const c = chunkAt(x >> 4, z >> 4);
  return c && c.height ? c.surfaceAt(x & 15, z & 15) : null;
};

const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);
const stamp = (sec) => new Date((tl.timeBaseSec + sec) * 1000).toISOString().replace('T', ' ').slice(0, 19);

const BANDS = [[0, 3, 'at the open sky'], [3, 16, 'down to 16 blocks'], [16, 60, '16-60 down'],
  [60, 1e9, 'more than 60 down']];
const band = (d) => (d < 0 ? 'above the surface' : BANDS.find(([lo, hi]) => d >= lo && d < hi)[2]);
const depths = [];
const perPlayer = new Map();
let noChunk = 0;
const surface = [];
let openCount = 0;

for (const p of pres.players) {
  const rows = handRows(tl, p.player);
  const step = Math.max(1, Math.floor(rows.length / N));
  const mine = [];
  for (let j = 0; j < rows.length; j += step) {
    const r = rows[j];
    const s = seatOf(tl, r, { solid, worldOf });
    if (s.seat !== 'ground') continue;
    const sky = skyOf(s.x, s.z);
    if (sky == null) { noChunk++; continue; }
    const d = sky - s.y;
    depths.push(d); mine.push(d);
    const open = inTheOpen(s.x, s.y, s.z);
    if (open) openCount++;
    if (d <= 2 && open && surface.length < 400) {
      surface.push({ player: p.player, name: nameOf(p.player), row: r, sec: tl.sec[r], at: stamp(tl.sec[r]),
        block: tl.nameOf(r), seat: s, sky, down: d });
    }
  }
  perPlayer.set(p.player, mine);
}

console.log(`${DIM}: ${pres.handRows} hand rows, ${depths.length} sampled bodies with a real heightmap under them `
  + `(${noChunk} sampled in chunks this cache does not hold)`);
console.log(`  in the open (own cells empty, 3 of 4 sides open): ${(100 * openCount / depths.length).toFixed(1)}%`
  + ' - the rest stand inside a build, a cave or foliage, where "obey walls" means you cannot see them');
const counts = new Map();
for (const d of depths) counts.set(band(d), (counts.get(band(d)) ?? 0) + 1);
for (const [, , label] of BANDS) console.log(`  ${label.padEnd(22)} ${((100 * (counts.get(label) ?? 0)) / depths.length).toFixed(1)}%`);
console.log(`  depth below WORLD_SURFACE: p50 ${q(depths, 0.5)} p90 ${q(depths, 0.9)} max ${Math.max(...depths)}`);
for (const [pl, arr] of perPlayer) {
  if (!arr.length) continue;
  const open = arr.filter((d) => d <= 2).length;
  console.log(`  ${nameOf(pl).padEnd(14)} sampled ${String(arr.length).padStart(4)}  at the surface ${(100 * open / arr.length).toFixed(1)}%  `
    + `deepest ${Math.max(...arr)} down`);
}

// The moments a browser picture can actually use: outside, in the open, and in a chunk the payload cache can
// serve. And the best of them by PARTY: the second where the most people stood outside at once.
const pick = [];
for (const s of surface) {
  if (pick.some((p) => p.player === s.player)) continue;
  pick.push(s);
}
console.log('\nmoments where a named player stood at the open sky, in the open (one per player):');
for (const s of pick) {
  console.log(`  ${s.at}  ${s.name.padEnd(14)} ${s.block.padEnd(28)} feet y ${String(s.seat.y).padStart(4)} `
    + `(WORLD_SURFACE ${s.sky})  at ${s.seat.x},${s.seat.z}  timeline sec ${s.sec}`);
}

// A picture of a party is worth more than a picture of one person, so the outdoor seconds are scored by how
// many people the log puts outside at the same moment.
const outside = new Map();
for (const s of surface) {
  let n = 0;
  const who = [];
  const at_ = [];
  for (const ans of bodiesAt(pres, s.sec)) {
    if (ans.absent) continue;
    const b = seatOf(tl, ans.row, { solid, worldOf });
    const sky = skyOf(b.x, b.z);
    if (sky != null && sky - b.y <= 2 && inTheOpen(b.x, b.y, b.z)) { n++; who.push(nameOf(ans.player)); at_.push([b.x, b.y, b.z]); }
  }
  if (n > (outside.get(s.sec)?.n ?? 0)) outside.set(s.sec, { n, who, at: s.at, seats: at_ });
}
const ranked = [...outside.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
console.log('\nseconds where two or more people stood at the open sky, in the open:');
for (const [sec, v] of ranked) console.log(`  sec ${String(sec).padStart(7)}  ${v.at}  ${v.n} outside: ${v.who.join(', ')}`
  + `  at ${v.seats.map((p) => p.join(',')).join(' | ')}`);
if (!ranked.length) console.log('  none: the party was outside together at no logged second this sample found');
