// M15 presence, measured on the shipped packs: who the log can place, when, and for how long.
//
// This is the numbers-behind-the-feature tool. The panel quotes some of it (the window, the visit count),
// and the rest is what stops a "where are the players?" bug report from being guesswork: at a given
// second, how many bodies does the evidence support, and what fraction of the log's seconds support any.
//
//   node build/dbg-presence.mjs                     # every baked dimension
//   node build/dbg-presence.mjs --dim=minecraft:the_nether --gap=600
import { readFileSync } from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { presenceOf, bodiesAt, seatOf, nearestVisit, trackOf, RUN_GAP_SEC } from '../shared/ghosts.mjs';

const arg = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const PACKS = {
  'minecraft:overworld': 'build/ledger/region.ledpack',
  'minecraft:the_nether': 'build/ledger/DIM-1_region.ledpack',
  'minecraft:the_end': 'build/ledger/DIM1_region.ledpack',
  'spellbladenext:glassocean': 'build/ledger/dimensions_spellbladenext_glassocean_region.ledpack',
};
const want = arg('dim', null);
const gap = +arg('gap', RUN_GAP_SEC);
const names = JSON.parse(readFileSync('build/ledger/meta.json', 'utf8')).players;
const nameOf = (i) => (i === 255 ? '(nobody)' : names[i]?.name ?? `#${i + 1}`);

/** Wall clock, because "second 623638" is not something a human can check against the log. */
const clock = (base, sec) => new Date((base + sec) * 1000).toISOString().replace('T', ' ').slice(0, 19);

for (const [dim, file] of Object.entries(PACKS)) {
  if (want && want !== dim) continue;
  const buf = readFileSync(file);
  const P = readPack(buf);
  if (!P.tlBytes) { console.log(`${dim}: no timeline in ${file}`); continue; }
  const t0 = Date.now();
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  const worldOf = (i) => P.cell(i);
  const t1 = Date.now();
  const pres = presenceOf(tl, { worldOf, gap });
  const t2 = Date.now();
  console.log(`\n${dim}: ${tl.count} rows v${tl.version}; decode ${t1 - t0} ms, presence ${t2 - t1} ms`);
  console.log(`  hand rows ${pres.handRows}, visits ${pres.visits} at a ${gap} s cut, ` +
    `players ${pres.players.length}`);
  if (!pres.players.length) { console.log('  nobody: no row in this dimension was caused by a named hand'); continue; }
  console.log(`  window: ${clock(tl.timeBaseSec, pres.first)} .. ${clock(tl.timeBaseSec, pres.last)} ` +
    `= ${(pres.spanSec / 86400).toFixed(2)} of ${(tl.spanSec / 86400).toFixed(1)} days ` +
    `(${(100 * pres.spanSec / tl.spanSec).toFixed(2)}%)`);
  for (const p of pres.players) {
    const biggest = p.visits.reduce((a, v) => (v.n > a.n ? v : a), p.visits[0]);
    console.log(`  ${nameOf(p.player).padEnd(14)} rows ${String(p.rows.length).padStart(6)}  ` +
      `visits ${String(p.visits.length).padStart(4)}  ` +
      `cells ${new Set(p.rows.map((i) => tl.cell[i])).size}  ` +
      `biggest visit ${biggest.n} actions / ${biggest.cells} chunks / ${biggest.across} blocks across  ` +
      `${clock(tl.timeBaseSec, biggest.t0)} -> ${clock(tl.timeBaseSec, biggest.t1)}`);
  }
  // Occupancy: merge the visit intervals, so "a body stands somewhere" becomes a percentage of seconds
  // rather than a count of rows. Without this the panel's "nobody here" looks like a bug.
  const iv = [];
  for (const p of pres.players) for (const v of p.visits) iv.push([v.t0, v.t1]);
  iv.sort((a, b) => a[0] - b[0]);
  let covered = 0, cur = -1;
  for (const [a, b] of iv) {
    if (a > cur) { covered += b - a; cur = b; } else if (b > cur) { covered += b - cur; cur = b; }
  }
  const per = pres.players.map((p) => p.visits.reduce((a, v) => a + (v.t1 - v.t0), 0));
  console.log(`  seconds with a body somewhere: ${covered} of ${tl.spanSec} ` +
    `(${(100 * covered / tl.spanSec).toFixed(2)}% of the log), summed per player ${per.reduce((a, b) => a + b, 0)}`);
  // How many bodies at once, at the busiest seconds: that is the per-frame cost of drawing people.
  const marks = [];
  for (const p of pres.players) for (const v of p.visits) { marks.push([v.t0, 1]); marks.push([v.t1 + 1, -1]); }
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0, peak = 0, peakAt = 0;
  for (const [s, d] of marks) { live += d; if (live > peak) { peak = live; peakAt = s; } }
  console.log(`  most players standing at once: ${peak}, at ${clock(tl.timeBaseSec, peakAt)}`);
  // Sample the answer at a spread of seconds, because "at most seconds nobody" is the fact a user will
  // notice first and it has to be in the panel, not hidden.
  const at = [];
  for (let k = 0; k <= 10; k++) {
    const s = Math.round(tl.spanSec * k / 10);
    const b = bodiesAt(pres, s);
    at.push(`${(100 * k / 10).toFixed(0)}%:${b.filter((x) => !x.absent).length}`);
  }
  console.log(`  bodies at 0/10../100% of the log: ${at.join(' ')}`);
  const near = nearestVisit(pres, Math.round(tl.spanSec / 2));
  if (near) {
    console.log(`  from the middle of the log, the nearest evidence is ${(near.dist / 86400).toFixed(2)} days away: ` +
    `${nameOf(near.player)} ${clock(tl.timeBaseSec, near.visit.t0)} -> ${clock(tl.timeBaseSec, near.visit.t1)} ` +
    `(${near.visit.n} actions)`);
    const tr = trackOf(tl, pres.players.find((p) => p.player === near.player), near.visit, { max: 8, worldOf });
    console.log(`  its track thinned to 8: ${tr.map((q) => `${q.x},${q.z}`).join(' ')}`);
    console.log(`  seat of the first action of it: ` +
      JSON.stringify(seatOf(tl, near.visit.first, { solid: () => true, worldOf })));
  }
}
