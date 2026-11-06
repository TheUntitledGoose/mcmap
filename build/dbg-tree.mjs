// Debug: what does the paint rule decide for a synthetic tall tree?
import fs from 'node:fs';
import { shellFromPayload } from '../server/shell.mjs';
import { packChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { openShellFrame } from '../web/js/payload.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const isSolid = (id) => cls.cube[id - 1] === 1;
const idOf = (k) => atlas.states.findIndex((s) => s.k === k) + 1;
const ID = {
  grass: idOf('minecraft:grass_block|snowy=false'),
  log: idOf('minecraft:oak_log|axis=y'),
  leaves: idOf('minecraft:spruce_leaves|distance=1,persistent=false,waterlogged=false'),
};
const nm = (id) => (id ? (atlas.states[id - 1]?.k ?? `?${id}`) : 'none');

const yMin = 3, yCount = 3;
const pal = [0, ID.grass, ID.log, ID.leaves];
const sects = new Map();
const put = (x, y, z, id) => {
  const sy = y >> 4;
  let vox = sects.get(sy);
  if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
  vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = pal.indexOf(id);
};
const stack = (x, z, from, to, id) => { for (let y = from; y <= to; y++) put(x, y, z, id); };
for (let z = 0; z <= 4; z++) for (let x = 8; x <= 15; x++) put(x, 63, z, ID.grass);
stack(12, 0, 64, 84, ID.log);
for (let z = 0; z <= 2; z++) for (let x = 11; x <= 13; x++) stack(x, z, 85, 88, ID.leaves);
for (let x = 9; x <= 11; x++) stack(x, 3, 64, 66, ID.log);
stack(15, 4, 64, 68, ID.log);

const height = new Uint16Array(256);
for (let z = 0; z < 16; z++) {
  for (let x = 0; x < 16; x++) {
    let top = 0;
    for (let y = (yMin + yCount) * 16 - 1; y >= yMin * 16; y--) {
      const vox = sects.get(y >> 4);
      if (vox && vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]) { top = y; break; }
    }
    height[(z << 4) | x] = top ? top + HEIGHT_BIAS : 0;
  }
}
const raw = packChunk({
  cx: 0, cz: 0, yMin, yCount, palette: pal,
  sections: [...sects.entries()].sort((a, b) => a[0] - b[0]).map(([y, vox]) => ({ y, single: 0, vox })),
  height, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: false,
});
const buf = shellFromPayload(raw, { isPaint, isSolid });
const sh = openShellFrame(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const at = (x, z) => ({
  surf: sh.surfaceAt(x, z), ground: sh.groundAt(x, z),
  cover: nm(sh.coverAt(x, z)), paint: nm(sh.stateAt(x, z)),
});
for (const [x, z] of [[12, 0], [10, 3], [15, 4], [13, 1], [12, 1], [11, 0]]) {
  console.log(`${x},${z}`, JSON.stringify(at(x, z)));
}
console.log('cube flags', { log: cls.cube[ID.log - 1], opaque: cls.opaque[ID.log - 1], leaves: cls.cube[ID.leaves - 1], lopaque: cls.opaque[ID.leaves - 1] });

// second pass: read the payload back the way shellFromPayload does
const { openChunk } = await import('../server/chunk-payload.mjs');
const c = openChunk(raw);
console.log('height col(12,0) =', c.height[(0 << 4) | 12] - HEIGHT_BIAS);
for (let y = 90; y >= 58; y--) {
  const id = c.stateAt(12, y, 0);
  if (id) console.log('  y', y, nm(id), 'cube', cls.cube[id - 1], 'opaque', cls.opaque[id - 1]);
}
