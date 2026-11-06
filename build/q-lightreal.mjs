import { readFileSync } from 'node:fs';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import { decodeChunk, packChunk, openChunk, buildStateIds } from '../server/chunk-payload.mjs';
import zlib from 'node:zlib';
const keys = JSON.parse(readFileSync('build/census.json', 'utf8')).states.map((s) => s.key);
const ids = buildStateIds(keys);
const rf = new RegionFile('DarkRPG/world/region/r.0.0.mca');
for (const [lx, lz] of [[0, 0], [3, 5]]) {
  const bytes = rf.readChunkNbtBytes(lx, lz);
  if (!bytes) continue;
  const nbt = readNbt(zlib.inflateSync(Buffer.from(bytes))).value;
  const withL = packChunk(decodeChunk(nbt, ids));
  const noL = packChunk(decodeChunk(nbt, ids, { light: false }));
  const open = openChunk(withL);
  const rows = open.sections.map((s) => {
    let skyU = 0, blkU = 0, skyV = 0, blkV = 0, n = 0, nonair = 0;
    for (let y = s.y * 16; y < s.y * 16 + 16; y++)
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const [sk, bl] = open.lightAt(x, y, z);
        if (sk === 15) skyU++; else skyV++;
        if (bl > 0) blkV++;
        if (open.stateAt(x, y, z)) nonair++;
        n++;
      }
    return `Y${String(s.y).padStart(3)} sky=${s.sky === 16 ? 'array' : s.sky} blk=${s.blk === 16 ? 'array' : s.blk} sky15=${String(skyU).padStart(4)} lit=${String(blkV).padStart(3)} air=${n - nonair}`;
  });
  console.log(`chunk ${lx + (rf.cx ?? 0) * 32},${lz}  gz ${zlib.gzipSync(noL).length} -> ${zlib.gzipSync(withL).length} B`);
  console.log(rows.join('\n'));
}
