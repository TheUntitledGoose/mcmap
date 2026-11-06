import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { decodeChunk, packChunk, buildStateIds } from '../server/chunk-payload.mjs';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const air = { Name: 'minecraft:air' }, stone = { Name: 'minecraft:stone' };
const cells = [];
for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) cells.push([lx, 0, lz]);
const data = new BigUint64Array(64);
for (const [lx, ly, lz] of cells) { const i = (ly << 8) | (lz << 4) | lx; data[i >> 6] |= 1n << BigInt(i & 63); }
const nbt = { xPos: 0, zPos: 0, yPos: 4, DataVersion: 3465, sections: [
  { Y: 4, block_states: { palette: [air, stone], data } },
  { Y: 5, block_states: { palette: [air], data: new BigUint64Array(0) } },
] };
const ch = openChunk(ab(packChunk(decodeChunk(nbt, ids))));
console.log('sections', ch.sections.map((s) => ({ y: s.y, single: s.single, vox: !!s.vox, sky: s.sky, blk: s.blk })));
console.log('stateAt(4,64,4)', ch.stateAt(4, 64, 4), 'palette', [...ch.palette].slice(0, 4));
const at = (cx, cz, lx, ly, lz) => { const s = ch.sectionAt(ly); if (!s) return -1; const id = ch.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]]; return id === 0 ? -1 : id - 1; };
const r = meshChunk(assets, ch, at, { ao: true, aoMin: 0.42 });
console.log('stats', r.stats);
const s0 = r.streams[0];
console.log('count', s0.count);
let shown = 0;
for (let i = 0; i < s0.count && shown < 8; i++) {
  const y = s0.position[i * 3 + 1];
  if (y > 60) { console.log('v', s0.position[i*3], y, s0.position[i*3+2], 'col', s0.color[i*4], s0.color[i*4+1], s0.color[i*4+2]); shown++; }
}

const dec = decodeChunk(nbt, ids);
console.log('decoded palette', [...dec.palette]);
const sec = dec.sections[0];
console.log('single', sec.single, 'vox@68', sec.vox[68], 'vox@0', sec.vox[0], 'vox@255', sec.vox[255]);
const nz = [...sec.vox].filter((v) => v !== 0).length;
console.log('nonzero voxels', nz, 'yMin', dec.yMin, 'yCount', dec.yCount);
