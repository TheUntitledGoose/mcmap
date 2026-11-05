import zlib from 'node:zlib'; import fs from 'node:fs';
import { readNbt } from './nbt.mjs';
import { RegionFile } from './region.mjs';
const files = fs.readdirSync('DarkRPG/world/region').filter(f=>f.endsWith('.mca'));
const pick = files.filter((_,i)=>i%40===0).slice(0,12);
const ns = new Map(); const names = new Set(); let styles = {}; let sections = 0, palettes = 0;
for (const f of pick) {
  const [rx, rz] = /r\.(-?\d+)\.(-?\d+)\.mca/.exec(f).slice(1).map(Number);
  const r = new RegionFile('DarkRPG/world/region/' + f);
  let done = 0;
  for (let z = 0; z < 32 && done < 6; z++) for (let x = 0; x < 32 && done < 6; x++) {
    if (!r.entry(x, z)) continue;
    let c; try { c = readNbt(zlib.inflateSync(r.readChunkNbtBytes(x, z))).value; } catch { continue; }
    done++;
    for (const s of c.sections ?? []) {
      sections++;
      if (s.block_states) styles.newFormat = (styles.newFormat||0)+1;
      else if (s.BlockStatePalette) styles.classic = (styles.classic||0)+1;
      else styles.empty = (styles.empty||0)+1;
      const pal = s.block_states?.palette ?? s.BlockStatePalette ?? [];
      if (!pal.length) continue;
      palettes++;
      for (const p of pal) {
        const n = p.Name; names.add(n);
        const k = n.split(':')[0]; ns.set(k, (ns.get(k)||0)+1);
      }
    }
  }
  r.close();
}
console.log('sampled region files:', pick.length, '| sections:', sections, '| formats:', JSON.stringify(styles));
console.log('distinct block state names:', names.size);
console.log('namespaces (by palette mentions):');
for (const [k,v] of [...ns].sort((a,b)=>b[1]-a[1])) console.log('  ', k.padEnd(26), v);
