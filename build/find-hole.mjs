// Where is a chunk slot inside a region file that exists but was left unwritten? The test needs a real
// hole (not a missing region file) to prove absence comes from the header without a marker file, and
// guessing coordinates is how the old MISS=[400,-400] ended up naming a region that does not exist.
import fs from 'node:fs';
import path from 'node:path';
import { RegionFile } from '../tools/region.mjs';

const dir = process.argv[2] || 'DarkRPG/world/region';
const want = +process.argv[3] || 3;
const names = fs.readdirSync(dir).filter((f) => /^r\.-?\d+\.-?\d+\.mca$/.test(f));
const cands = [];
for (const f of names) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
  const rx = +m[1], rz = +m[2];
  const rgn = new RegionFile(path.join(dir, f));
  let present = 0;
  const holes = [];
  for (let z = 0; z < 32; z++) {
    for (let x = 0; x < 32; x++) {
      if (rgn.entry(x, z)) present++;
      else holes.push([rx * 32 + x, rz * 32 + z]);
    }
  }
  rgn.close();
  if (present > 0 && holes.length > 0) cands.push({ f, rx, rz, present, holes: holes.length, first: holes.slice(0, 4) });
}
cands.sort((a, b) => b.holes - a.holes);
console.log(`regions scanned ${names.length}, partially filled ${cands.length}`);
for (const c of cands.slice(0, want)) console.log(JSON.stringify(c));
// A fully filled region is the other half of the story: no holes at all, so absence must come from a
// missing region file there.
console.log('fully filled regions:', names.length - cands.length);
