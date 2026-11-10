// M15 planning measurement: what would a "stand the players back in time" layer have to work with?
//
// The browser already holds one dimension's whole edit history (`LEDTL1` v3 rows in a .ledpack), so the
// honest first question is not "can we render bodies" but "how dense is one player's track, how far apart
// are consecutive steps, and how much of the log has no player at all". This reads the baked packs - the
// same bytes the page gets - and answers in seconds and blocks.
//
//   node build/dbg-ghosttrack.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';

const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// Player names are not in the pack (it stores a 1-byte index); the meta endpoint carries them. Fall back
// to the bare index if worldd is not up, because the numbers below do not need names.
let who = [];
try { who = (await (await fetch('http://127.0.0.1:8765/ledger/meta')).json()).players.map((x) => x.name) ?? []; } catch { /* no server: index-only */ }

const files = readdirSync('build/ledger').filter((f) => f.endsWith('.ledpack')).map((f) => `build/ledger/${f}`);
for (const f of files) {
  const buf = new Uint8Array(readFileSync(f));
  const p = readPack(buf);
  const tl = p.tlBytes ? decodeTimeline(buf.subarray(p.tlBytes[0], p.tlBytes[1])) : null;
  console.log(`\n=== ${f}  dim ${p.dimKey}  rows ${p.rowCount}  timeline ${p.tlBytes} B` +
    `  v${tl?.version ?? '-'}  tlRows ${tl?.count ?? 0}  names ${tl?.names?.length ?? 0}`);
  if (!tl) continue;
  const cells = p.cell ? (() => { const a = []; for (let i = 0; i < p.cellCount; i++) a.push(p.cell(i)); return a; })() : [];
  const byPlayer = new Map(); const byAction = new Map(); const win = new Map();
  let minSec = Infinity, maxSec = -Infinity;
  for (let i = 0; i < tl.count; i++) {
    const pl = tl.player[i];
    byPlayer.set(pl, (byPlayer.get(pl) ?? 0) + 1);
    byAction.set(tl.action[i], (byAction.get(tl.action[i]) ?? 0) + 1);
    const s = tl.sec[i];
    if (s < minSec) minSec = s; if (s > maxSec) maxSec = s;
    if (pl !== 255) { const e = win.get(pl) ?? [s, s]; e[0] = Math.min(e[0], s); e[1] = Math.max(e[1], s); win.set(pl, e); }
  }
  console.log(`  base ${tl.timeBaseSec}  span ${maxSec - minSec} s = ${((maxSec - minSec) / 86400).toFixed(2)} d`);
  console.log(`  player slots: ${who.length}`);
  console.log(`  rows by player: ${[...byPlayer.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k === 255 ? 'nobody' : `${who[k]}#${k}`} ${v}`).join('   ')}`);
  console.log(`  rows by action: ${[...byAction.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  console.log(`  first/last second per player:`);
  for (const [k, [a, b]] of win) {
    const at = (s) => new Date((tl.timeBaseSec + s) * 1000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`    ${who[k] ?? k}: ${at(a)} -> ${at(b)}  (${((b - a) / 3600).toFixed(1)} h)`);
  }
  // Per player: how far apart are consecutive steps, and how long is the gap to the next one?
  for (const [k] of win) {
    const rows = [];
    for (let i = 0; i < tl.count; i++) if (tl.player[i] === k) rows.push(i);
    const gaps = [], moves = []; const big = [];
    for (let j = 1; j < rows.length; j++) {
      const a = rows[j - 1], b = rows[j];
      gaps.push(tl.sec[b] - tl.sec[a]);
      const ca = cells[tl.cellOf(a)], cb = cells[tl.cellOf(b)];
      const d = Math.max(Math.abs(ca.cx * 16 + tl.x(b) - (ca.cx * 16 + tl.x(a))),
        Math.abs(ca.cz * 16 + tl.z(b) - (ca.cz * 16 + tl.z(a))), Math.abs(tl.y(b) - tl.y(a)));
      moves.push(d);
      if (gaps[j - 1] > 120 || d > 32) big.push([gaps[j - 1], d]);
    }
    const cellsTouched = new Set(rows.map((i) => `${cells[tl.cellOf(i)].cx >> 1},${cells[tl.cellOf(i)].cz >> 1}`)).size;
    console.log(`    ${who[k] ?? k}: n ${rows.length}  gap med ${pct(gaps, 0.5)}s p90 ${pct(gaps, 0.9)}s p99 ${pct(gaps, 0.99)}s max ${Math.max(...gaps)}s` +
      `  move med ${pct(moves, 0.5)} p90 ${pct(moves, 0.9)} max ${Math.max(...moves)} blocks` +
      `  within2 ${Math.round(100 * moves.filter((d) => d <= 2).length / moves.length)}% within8 ${Math.round(100 * moves.filter((d) => d <= 8).length / moves.length)}%` +
      `  cuts(gap>120s or move>32) ${big.length}  32-block cells touched ${cellsTouched}`);
  }
}
