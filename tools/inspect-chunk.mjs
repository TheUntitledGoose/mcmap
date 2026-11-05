import zlib from 'node:zlib';
import { readNbt } from './nbt.mjs';
import { RegionFile } from './region.mjs';
const r = new RegionFile('DarkRPG/world/region/r.0.0.mca');
const c = readNbt(zlib.inflateSync(r.readChunkNbtBytes(3, 5))).value;
console.log('yPos', c.yPos, 'sections', c.sections.length, 'isLightOn', c.isLightOn);
console.log('Heightmaps MOTION_BLOCKING len', c.Heightmaps.MOTION_BLOCKING?.length);
const Ys = c.sections.map(s => Number(s.Y));
console.log('section Ys:', Ys.join(','));
for (const s of c.sections) {
  const keys = Object.keys(s);
  if (!keys.includes('block_states')) { console.log(`Y=${Number(s.Y)}: EMPTY/other -> ${keys.join(',')}`); continue; }
  const bs = s.block_states;
  console.log(`Y=${Number(s.Y)} block_states keys={${Object.keys(bs)}} palette=${bs.palette.length} data=${bs.data ? bs.data.constructor.name + '(' + bs.data.length + ')' : 'ABSENT'}`);
  if (bs.palette.length > 1 && bs.palette.length <= 20) console.log('   palette:', bs.palette.map(p => p.Name + (p.Properties ? '[' + Object.entries(p.Properties).map(([k,v])=>k+'='+v).join(',') + ']' : '')).join(' | '));
  else if (bs.palette.length > 20) console.log('   palette head:', bs.palette.slice(0,8).map(p=>p.Name).join(', '));
  const nonEmpty = c.sections.filter(x => x.block_states);
  break;
}
// section with blocks: find max palette
const biggest = c.sections.filter(s=>s.block_states).sort((a,b)=>b.block_states.palette.length-a.block_states.palette.length)[0];
console.log('\nlargest palette section:', Number(biggest.Y), biggest.block_states.palette.length, 'entries, data', biggest.block_states.data?.length);
console.log('sample names:', [...new Set(biggest.block_states.palette.map(p=>p.Name))].slice(0,25).join(', '));
r.close();
