/**
 * Should the skin byte stop at films? `minecraft:water` is cube=1, opaque=0, film=1, so a lake column
 * reports a skin as deep as the water (39 blocks where the Glassocean lake bed is gravel). That is not a
 * skin, it is the lake.
 *
 * The cap rule refuses a film cover, so such a column draws nothing extra today. This answers whether
 * excluding films from the byte changes anything that renders, or only cleans the data - which decides
 * whether it is worth another shell + LOD rebake.
 *
 *   node build/scan_bandfilm.mjs
 */
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { atlasStamp } from '../server/shell-pack.mjs';
import { openChunk, openShellFrame } from '../web/js/payload.js';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
const STATE_UNKNOWN = 0;   // a chunk state ID of 0 means the palette had something unrenderable

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const isSolid = (id) => !!id && id !== STATE_UNKNOWN && cls.cube[id - 1] === 1;
const isPaint = (id) => isSolid(id) && cls.opaque[id - 1] === 1;
const isFilm = (id) => !!id && cls.film[id - 1] === 1;
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: isPaint,
  isSolidState: isSolid,
  packDir: 'build/shells',
  stamp: atlasStamp(fs.statSync('build/assets/atlas.json'), atlas.states.length),
});
const stateName = (id) => atlas.states[id - 1]?.k ?? String(id);

const spots = [[0, 0], [54, 63], [2976, 2007], [-40, -120], [900, 900], [-900, -900], [9999, 9999], [-4000, 3000]];
let cols = 0, filmInBand = 0, filmTop = 0, differ = 0, drawDiff = 0;
const examples = [];
for (const [x, z] of spots) {
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    const cx = (x >> 4) + dx * 9, cz = (z >> 4) + dz * 9;
    // The frame carries the surface and ground the bake itself chose, so the only thing re-derived here
    // is whether the counted run is skin or film.
    const fb = svc.shellBytes('minecraft:overworld', cx, cz);
    const pb = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!fb || !pb) continue;
    const sh = openShellFrame(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.length));
    const c = openChunk(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.length));
    for (let i = 0; i < 256; i++) {
      const lx = i & 15, lz = i >> 4, wx = cx * 16 + lx, wz = cz * 16 + lz;
      const top = sh.height[i] - HEIGHT_BIAS, py = sh.ground[i] - HEIGHT_BIAS;
      const at = (yy) => c.stateAt(wx, yy, wz);
      const tid = at(top);
      if (!isSolid(tid) || isPaint(tid)) continue;
      cols++;
      if (isFilm(tid)) filmTop++;
      const room = Math.min(254, top - py + 1);
      let strict = 0, saw = 0;
      while (strict < room) {
        const s2 = at(top - strict);
        if (!s2 || !isSolid(s2)) break;
        if (isFilm(s2)) saw = 1;
        strict++;
      }
      if (strict >= room) { strict = 0; saw = 0; }
      if (saw) filmInBand++;
      const old = sh.band[i];
      if (old !== strict) {
        differ++;
        // A film surface is refused by the cap rule either way, so only a film *inside* a non-film skin
        // can make a drawn cap wrong.
        if (!isFilm(tid) && ((old >= 4 && top - old + 1 > py) || (strict >= 4 && top - strict + 1 > py))) {
          drawDiff++;
          if (examples.length < 8) examples.push(`${wx},${wz} surface y=${top} ground=${py} top=${stateName(tid)} byte ${old} -> ${strict}`);
        }
      }
    }
  }
}
console.log(`columns whose surface refuses the paint rule ${cols}`);
console.log(`  with a film surface (water, glass, ...) ${filmTop}`);
console.log(`  with a film block somewhere in the counted run ${filmInBand}`);
console.log(`bytes that change when films stop the run ${differ}`);
console.log(`  ... of which a cap would draw, wrongly: ${drawDiff}`);
for (const e of examples) console.log(`  ${e}`);
