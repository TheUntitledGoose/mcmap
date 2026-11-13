// What does each face-cull rule and each dedupe rule cost, on the shipped pack?
//
// The fix under test is time-of-claim culling (`cull: 1`): a face is inside the build only from the second
// its other side was claimed. The shipped rule (`cull: 2`) culled against every claim in the filter, which
// buried 442,673 faces of the overworld any-change filter behind blocks that had not been placed yet. The
// question this answers is what that correctness buys back in geometry: faces, verts, MB, and whether the
// filter still fits the memory ceiling the page sets.
import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { Assets } from '../web/js/assets.js';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { filterRows } from '../web/js/ledger-time.mjs';

const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const byName = stateIdsByName(assets.states);

const file = process.argv[2] || 'build/ledger/region.ledpack';
const raw = fs.readFileSync(file);
const P = readPack(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const tl = decodeTimeline(raw.subarray(P.tlBytes[0], P.tlBytes[1]));
console.log(`${file}: ${tl.count} timeline rows`);

const mb = (n) => (n / 1048576).toFixed(1);
const cases = [
  ['cull off, every claim', { cull: 0, dedupe: false }],
  ['cull AT THE CLAIM (new default)', { cull: 1, dedupe: false }],
  ['cull WHOLE FILTER (old rule)', { cull: 2, dedupe: false }],
  ['cull at the claim + dedupe', { cull: 1, dedupe: true }],
  ['cull whole filter + dedupe (shipped)', { cull: 2, dedupe: true }],
];
for (const cls of [2, 0]) {
  const got = filterRows(tl, { who: 0, cls });
  console.log(`\nfilter cls ${cls} (${cls === 2 ? 'place' : 'any change'}): ${got.n} rows`);
  for (const [label, opts] of cases) {
    resetMarkerLift();
    const b = buildTimeBlocks(tl, P, got.order, assets, byName, { ...opts });
    const s = b.stats;
    console.log(`  ${label.padEnd(31)} markers ${String(s.markers).padStart(7)} faces ${String(s.faces).padStart(8)}`
      + ` culled ${String(s.culled).padStart(7)} inside ${String(s.enclosed).padStart(6)}`
      + ` deduped ${String(s.deduped).padStart(6)} verts ${String(s.verts).padStart(9)} MB ${mb(s.bytes).padStart(7)}`
      + ` deepest ${s.deepest || s.maxStack}`);
  }
}
