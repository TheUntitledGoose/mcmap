import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { decodeChunk, packChunk, buildStateIds } from '../server/chunk-payload.mjs';
import { combineLight, lightLevels } from '../shared/light.mjs';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const air = { Name: 'minecraft:air' }, stone = { Name: 'minecraft:stone' };
const lightArr = (v) => {
  const a = new Uint8Array(2048);
  if (typeof v === 'number') a.fill((v & 15) | ((v & 15) << 4));
  else for (let i = 0; i < 4096; i++) { const b = v(i) & 15, at = i >> 1; a[at] = i & 1 ? (a[at] & 0x0f) | (b << 4) : (a[at] & 0xf0) | b; }
  return a;
};
const cellIdx = (lx, ly, lz) => (ly << 8) | (lz << 4) | lx;
function mk(specs) {
  const sections = specs.map((sp) => {
    const s = { Y: sp.y };
    const bits = 4;
    const data = new BigUint64Array(Math.ceil(4096 * bits / 64));
    s.block_states = { palette: sp.all ? [sp.all] : [air, sp.state ?? stone], data: sp.all ? new BigUint64Array(0) : data };
    for (const [lx, ly, lz] of sp.set ?? []) { const bit = cellIdx(lx, ly, lz) * bits; data[bit >> 6] |= 1n << BigInt(bit & 63); }
    if (sp.sky !== undefined) s.SkyLight = lightArr(sp.sky);
    if (sp.blk !== undefined) s.BlockLight = lightArr(sp.blk);
    return s;
  });
  return openChunk(ab(packChunk(decodeChunk({ xPos: 0, zPos: 0, yPos: 4, DataVersion: 3465, sections }, ids))));
}
const floorCells = [];
for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) floorCells.push([lx, 0, lz]);
const pool = (i) => {
  const ly = i >> 8, lz = (i >> 4) & 15, lx = i & 15;
  if (ly !== 1) return 0;
  const d = Math.max(Math.abs(lx - 8), Math.abs(lz - 8));
  return d === 0 ? 15 : d === 1 ? 8 : 0;
};
const ch = mk([{ y: 4, set: floorCells, sky: 0, blk: pool }, { y: 5, state: air, sky: 0, blk: pool }]);
console.log('sections', ch.sections.map((s) => ({ y: s.y, single: s.single, sky: s.sky, blk: s.blk })));
console.log('light at (8,65,8)', lightLevels(ch.sectionAt, 8, 65, 8), 'at (7,65,8)', lightLevels(ch.sectionAt, 7, 65, 8), 'at (7,64,8)', lightLevels(ch.sectionAt, 7, 64, 8));
const at = (cx, cz, lx, ly, lz) => { const s = ch.sectionAt(ly); if (!s) return -1; const id = ch.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)]]; return id === 0 ? -1 : id - 1; };
const light = (cx, cz, lx, ly, lz) => { const lv = lightLevels(ch.sectionAt, lx, ly, lz); return lv ? combineLight(lv[0], lv[1], 1) : -1; };
const r = meshChunk(assets, ch, at, { ao: false, light, darkFloor: 0.32, darkGamma: 1 });
const s0 = r.streams[0];
console.log('stats', r.stats);
for (let i = 0; i < s0.count; i++) {
  const x = s0.position[i*3], y = s0.position[i*3+1], z = s0.position[i*3+2];
  if (Math.abs(y - 65) < 1e-4 && x >= 6 && x <= 9 && z >= 7 && z <= 10)
    console.log('v', x, y, z, 'col', s0.color[i*4], s0.color[i*4+1], s0.color[i*4+2]);
}
