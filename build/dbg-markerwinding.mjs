// Does a marker cube face OUTWARD? The chunk mesher's winding renders fine in the page, so the question is
// whether the marker path inherited it. Signed volume of the emitted triangles answers it without a GPU:
// > 0 with CCW-outward winding (right-hand rule), < 0 means the layer is inside-out and a FrontSide material
// culls the near skin, which is what "I see the opposite faces / faces missing on some sides" looks like.
import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { fakeLog } from '../tests/fake-ledger.mjs';

const T = (s) => 1717174690000 + s * 1000;
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const g = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(json, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
const byName = stateIdsByName(assets.states);

function one(name, actionId, oldName) {
  const L = fakeLog([[1, 2, 64, 3, actionId, 1, T(10), name, oldName]]);
  const { buf } = buildPack(L, 1, 'region', { heightOf: () => 64 });
  const P = readPack(buf);
  const tl = decodeTimeline(buf.subarray(P.tlBytes[0], P.tlBytes[1]));
  resetMarkerLift();
  return buildTimeBlocks(tl, P, Array.from({ length: tl.count }, (_, i) => i), assets, byName, { grow: 1 });
}

function signedVolume(b) {
  const pos = b.pos, idx = b.idx;
  let vol = 0;
  for (let k = 0; k + 2 < idx.length; k += 3) {
    const a = idx[k] * 3, c = idx[k + 1] * 3, d = idx[k + 2] * 3;
    vol += (pos[a] * (pos[c + 1] * pos[d + 2] - pos[c + 2] * pos[d + 1]))
      - (pos[a + 1] * (pos[c] * pos[d + 2] - pos[c + 2] * pos[d]))
      + (pos[a + 2] * (pos[c] * pos[d + 1] - pos[c + 1] * pos[d]));
  }
  return vol / 6;
}

for (const [label, b] of [
  ['stone cube (place)', one('minecraft:stone', 2, 'minecraft:air')],
  ['oak_stairs model (place)', one('minecraft:oak_stairs', 2, 'minecraft:air')],
]) {
  console.log(`${label}: markers ${b.stats.markers} cubes ${b.stats.cubes} models ${b.stats.models}`
    + ` quads ${b.stats.quads} signed volume ${signedVolume(b).toFixed(4)}`);
}
