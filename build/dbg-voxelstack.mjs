// How many logged claims stack up on ONE voxel? This is what decides whether a later marker can be made to
// enclose the earlier ones, and how far the enclosure has to reach. Reads the baked packs the page holds.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeTimeline, readPack } from '../shared/ledger-pack.mjs';

// A pack path, or a dimension name (resolved through build/ledger/meta.json, where the overworld is
// "region" - the pack name is the save's own dimension folder, not its namespaced id).
const arg = process.argv[2] ?? 'minecraft:overworld';
const dir = process.argv[3] ?? 'build/ledger';
const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const d = meta.dims.find((x) => x.pack === arg || x.dimId === arg || x.dimKey === arg
  || x.dimId === arg.replace(/_/, ':').replace(/^dim(-1|1)$/, 'minecraft:$1')) ?? meta.dims[0];
const f = path.join(dir, d.pack);
const want = d.dimId;
const pack = readPack(readFileSync(f));
const tl = decodeTimeline(readFileSync(f).subarray(pack.tlBytes[0], pack.tlBytes[1]));

// Every filter the panel can ask for, and "any change": the stack a viewer actually sees.
const filters = { any: () => true, change: (a) => a === 0, place: (a) => a === 1, break: (a) => a === 2 };
console.log(`${want}: pack ${statSync(f).size.toLocaleString()} B, timeline ${tl.count.toLocaleString()} rows`
  + `, ${pack.cellCount.toLocaleString()} touched chunks`);

for (const [name, ok] of Object.entries(filters)) {
  const per = new Map();
  let n = 0;
  for (let i = 0; i < tl.count; i++) {
    if (!ok(tl.action[i])) continue;
    n++;
    const k = tl.cellOf(i) * 2097152 + tl.coord[i];
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  const hist = new Map();
  let max = 0, stacked = 0, stackRows = 0;
  for (const c of per.values()) {
    hist.set(c, (hist.get(c) ?? 0) + 1);
    if (c > max) max = c;
    if (c > 1) { stacked++; stackRows += c; }
  }
  const sorted = [...hist.entries()].sort((a, b) => a[0] - b[0]);
  let acc = 0;
  const pct = (p) => { for (const [c, h] of sorted) { acc += h; if (acc / per.size >= p) return c; } return max; };
  const over = (k) => sorted.filter(([c]) => c >= k).reduce((s, [, h]) => s + h, 0);
  console.log(`  ${name}: ${n.toLocaleString()} rows on ${per.size.toLocaleString()} voxels`
    + `; ${stacked.toLocaleString()} voxels hold >1 claim (${(100 * stacked / per.size).toFixed(1)}%)`
    + ` covering ${stackRows.toLocaleString()} rows; max ${max}`
    + `\n      p50 ${pct(0.5)} p90 ${pct(0.9)} p99 ${pct(0.99)}; voxels with >=3 ${over(3)}, >=5 ${over(5)}, >=9 ${over(9)}`);
}
