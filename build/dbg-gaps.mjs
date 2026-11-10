// M15.2 measurement: how far apart one player's hand rows are, in seconds AND in blocks.
//
// A ghost body is only honest if it is cut where the person stopped acting, and the threshold that cuts
// it is a number somebody has to justify. The two facts that justify it: (a) the gap distribution
// between a player's own hand row and their next one, and (b) how far the hand MOVED across such a gap.
// A 40 s gap that moves the hand 3 blocks is one walk; a 40 s gap that moves it 90 blocks is two visits.
//
//   node build/dbg-gaps.mjs                        # overworld
//   node build/dbg-gaps.mjs --dim=minecraft:the_nether
import { readFileSync } from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DIMS = {
  'minecraft:overworld': 'build/ledger/region.ledpack',
  'minecraft:the_nether': 'build/ledger/DIM-1_region.ledpack',
  'minecraft:the_end': 'build/ledger/DIM1_region.ledpack',
  'spellbladenext:glassocean': 'build/ledger/dimensions_spellbladenext_glassocean_region.ledpack',
};
const dim = arg('dim', 'minecraft:overworld');
const file = DIMS[dim];
if (!file) throw new Error(`no baked pack known for ${JSON.stringify(dim)} (try ${Object.keys(DIMS).join(', ')})`);

const buf = readFileSync(file);
const p = readPack(buf);
if (!p.tlBytes) throw new Error(`${file}: this pack carries no timeline`);
const tl = decodeTimeline(buf.subarray(p.tlBytes[0], p.tlBytes[1]), p);
const cell = (i) => p.cell(i);
const names = JSON.parse(readFileSync('build/ledger/meta.json', 'utf8')).players;
const nameOf = (idx) => (idx === 255 ? '' : names[idx]?.name ?? `#${idx + 1}`);

console.log(`${dim}: ${tl.count} timeline rows v${tl.version}, ` +
  `hand source ${JSON.stringify(tl.srcNames[tl.handSrc] ?? '(none)')}, cells ${p.cellCount}`);

const pct = (arr, q) => { const a = Float64Array.from(arr).sort(); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0; };
const GAPS = [10, 30, 60, 120, 300, 600, 1800, 3600, 4 * 3600, 24 * 3600, 7 * 24 * 3600];

const worldX = (i) => cell(tl.cell[i]).cx * 16 + tl.x(i);
const worldZ = (i) => cell(tl.cell[i]).cz * 16 + tl.z(i);
const handRows = (pl) => {
  const out = [];
  for (let i = 0; i < tl.count; i++) if (tl.player[i] === pl && tl.byHand(i)) out.push(i);
  return out;
};
const runCount = (rows, cut) => {
  let n = 0, prev = null;
  for (const i of rows) { if (prev === null || tl.sec[i] - prev > cut) n++; prev = tl.sec[i]; }
  return n;
};

const perPlayer = [];
for (let pl = 0; pl < 64; pl++) {
  const rows = handRows(pl);
  if (!rows.length) break;
  const dgap = [], djump = [];
  const over = new Map(GAPS.map((g) => [g, { n: 0, jump: [] }]));
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    const g = tl.sec[b] - tl.sec[a];
    const cheb = Math.max(Math.abs(worldX(a) - worldX(b)), Math.abs(worldZ(a) - worldZ(b)));
    dgap.push(g); djump.push(cheb);
    for (const gg of GAPS) if (g > gg) { const e = over.get(gg); e.n++; e.jump.push(cheb); }
  }
  perPlayer.push({ pl, rows, dgap });
  const mins = (s) => (s / 60).toFixed(1);
  console.log(`\n${nameOf(pl)}: ${rows.length} hand rows over ` +
    `${mins(tl.sec[rows[rows.length - 1]] - tl.sec[rows[0]])} min of acting, ` +
    `${new Set(rows.map((i) => tl.cell[i])).size} chunk cells`);
  console.log(`  hand-row gap: p50 ${pct(dgap, 0.5)}s p90 ${pct(dgap, 0.9)}s p99 ${pct(dgap, 0.99)}s max ${pct(dgap, 1)}s`);
  console.log(`  hand moved between consecutive rows: p50 ${pct(djump, 0.5)} p90 ${pct(djump, 0.9)} ` +
    `p99 ${pct(djump, 0.99)} max ${pct(djump, 1)} blocks`);
  for (const g of GAPS) {
    const e = over.get(g);
    if (!e.n) continue;
    console.log(`    cut >${String(g).padStart(6)}s: ${String(e.n).padStart(6)} gaps, ` +
      `jump p50 ${pct(e.jump, 0.5)} p90 ${pct(e.jump, 0.9)} blocks -> ${runCount(rows, g)} runs`);
  }
}

console.log('\nas a picture: bodies a frame could draw at each cut');
for (const cut of [60, 300, 900, 3600]) {
  const runs = perPlayer.reduce((a, x) => a + runCount(x.rows, cut), 0);
  console.log(`  cut ${String(cut).padStart(5)}s: ${runs} runs across ${perPlayer.length} players`);
}

const spanOf = (pl) => {
  const rows = handRows(pl);
  return rows.length ? [tl.sec[rows[0]], tl.sec[rows[rows.length - 1]]] : null;
};
console.log('\nwhen the log can name a body at all (seconds since the timeline base):');
for (let pl = 0; pl < perPlayer.length; pl++) {
  const s = spanOf(pl);
  console.log(`  ${nameOf(pl)}: ${s[0]} .. ${s[1]}  (${((s[1] - s[0]) / 86400).toFixed(2)} days, ` +
    `${runCount(handRows(pl), 300)} runs at a 5 min cut)`);
}
let lo = Infinity, hi = -Infinity;
for (let pl = 0; pl < perPlayer.length; pl++) { const s = spanOf(pl); lo = Math.min(lo, s[0]); hi = Math.max(hi, s[1]); }
console.log(`  union: ${lo} .. ${hi} = ${((hi - lo) / 86400).toFixed(2)} days of the ` +
  `${tl.spanSec / 86400} day log (${(100 * (hi - lo) / tl.spanSec).toFixed(1)}%)`);
