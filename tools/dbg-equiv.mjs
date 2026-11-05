import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { packChunk, buildStateIds } from '../server/chunk-payload.mjs';
const a = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const A = new Assets(a, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.length));
const stone = A.indexOf('minecraft:stone') + 1, grass = A.indexOf('minecraft:grass_block|snowy=false') + 1, air = A.indexOf('minecraft:air') + 1;
const vox = new Uint16Array(4096).fill(2);
for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
  vox[(1 << 8) | (lz << 4) | lx] = 1;
  vox[(2 << 8) | (lz << 4) | lx] = (lx + lz) % 2 ? 0 : 2;
}
const raw = packChunk({
  cx: 4, cz: 4, yMin: 2, yCount: 3, palette: [stone, grass, air],
  sections: [{ y: 2, single: 0, vox }, { y: 3, single: 1, vox: null }, { y: 4, single: 1, vox: null }],
  height: null, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: 0,
});
const c = openChunk(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
console.log('sections', c.sections.map((s) => `y=${s.y} single=${s.single} vox=${s.vox ? s.vox[0] : '-'}`));
const lh = { ...c, sections: c.sections.map((s) => (s.single ? { ...s, single: 0, vox: new Uint16Array(4096).fill(s.single - 1) } : s)) };
const at = () => -1;
for (const [name, ch] of [['packed', c], ['longhand', lh]]) {
  const r = meshChunk(A, ch, at, { ao: true });
  console.log(name, 'counts', r.streams.map((s) => s.count).join('/'), 'stats', JSON.stringify(r.stats));
}
