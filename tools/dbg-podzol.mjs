import { readFileSync } from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { tintOf } from '../web/js/mesher.js';
const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const gb = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.length));
const tex = (id) => a.textures.find((t) => t.id === id);
for (const id of ['minecraft:block/podzol_top', 'minecraft:block/podzol_side', 'minecraft:block/stone',
  'minecraft:block/water_still', 'minecraft:block/sand', 'minecraft:block/grass_block_top',
  'minecraft:block/dirt']) {
  const t = tex(id);
  console.log(id, JSON.stringify({ c: t?.c, g: t?.g, kind: t?.kind }));
}
for (const k of ['minecraft:podzol|snowy=false', 'minecraft:stone', 'minecraft:water|level=0', 'minecraft:sand']) {
  const i = assets.indexOf(k), st = assets.states[i];
  // detail geometry: which texture paints which direction
  const per = {};
  for (const arm of st.g ?? []) for (const qi of arm) {
    const pk = assets.ref[qi * 2 + 1], t = pk & 0xfff, d = ((pk >> 12) & 7) - 1;
    if (d >= 0 && per[d] === undefined) per[d] = a.textures[t].id;
  }
  console.log(k, 'idx', i, 'ti', st.ti, 'cube', st.cube ? 1 : 0, 'fc', st.fc, 'tint', JSON.stringify(tintOf(st)));
  console.log('   detail face sprites:', JSON.stringify(per));
}
