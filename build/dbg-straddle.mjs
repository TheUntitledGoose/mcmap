// Which voxels let us PROVE the highlight answers the second being drawn, and not today?
// Find voxels in one chunk that were claimed before a given second and claimed AGAIN after it, with a
// different name each time: at the playhead the log says block A stands there, today the world holds block
// B, and the newest claim in the whole filter is B. A layer that deduped to the newest claim, or a highlight
// that reads the present-day mesh, answers B; the honest answer at that second is A.
// node build/dbg-straddle.mjs [sec=112612] [cx=-3] [cz=-8]
import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';

const SEC = +(process.argv[2] ?? 112612);
const CX = +(process.argv[3] ?? -3), CZ = +(process.argv[4] ?? -8);
const buf = fs.readFileSync('build/ledger/region.ledpack');
const P = readPack(buf);
const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));

const claims = new Map();                         // "x,y,z" -> [{row, sec, action, name}]
for (let i = 0; i < tl.count; i++) {
  const c = P.cell(tl.cellOf(i));
  if (c.cx !== CX || c.cz !== CZ) continue;
  const x = c.cx * 16 + tl.x(i), y = tl.y(i), z = c.cz * 16 + tl.z(i);
  const k = `${x},${y},${z}`;
  if (!claims.has(k)) claims.set(k, []);
  claims.get(k).push({ row: i, sec: tl.sec[i], action: tl.action[i], name: tl.nameOf(i) });
}
console.log(`cell ${CX},${CZ}: ${claims.size} claimed voxels; playhead second ${SEC}`);

const straddle = [];
for (const [k, list] of claims) {
  const before = list.filter((c) => c.sec <= SEC);
  const after = list.filter((c) => c.sec > SEC);
  if (!before.length || !after.length) continue;
  const last = before[before.length - 1], first = after[0];
  if (last.name === first.name) continue;         // the name must actually disagree
  straddle.push({ k, list, last, first });
}
console.log(`${straddle.size} voxels in this chunk change name across that second`);
for (const s of straddle.slice(0, 12)) {
  const [x, y, z] = s.k.split(',').map(Number);
  console.log(`  ${s.k}  claims ${s.list.length}`);
  for (const c of s.list.slice(0, 6)) {
    console.log(`     row ${String(c.row).padStart(6)} sec ${String(c.sec).padStart(6)} action ${c.action}`
      + `  ${c.name}${c.sec <= SEC ? '   <- stands at the playhead' : '   (later)'}`);
  }
}
