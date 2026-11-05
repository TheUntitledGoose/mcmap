// dbg-alphamean — mean alpha of the atlas cells for the translucent sprites. The GPU multiplies the
// texture's alpha into the fragment alpha, so the blend weight a translucent quad really gets is
// material opacity * texture alpha. Assuming the opacity alone makes a water pixel look wrong when
// it is only the model of it that is wrong.
import { readFileSync } from 'node:fs';
import { decodePng } from '../server/png.mjs';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const img = decodePng(readFileSync('build/assets/atlas.png'));
const size = a.atlasSize;
const rgba = img.rgba;

for (const t of a.textures) {
  if (t.kind !== 2) continue;
  let n = 0, alpha = 0, rgb = [0, 0, 0];
  for (let y = 0; y < t.h; y++) {
    for (let x = 0; x < t.w; x++) {
      const i = ((t.y + y) * size + (t.x + x)) * 4;
      alpha += rgba[i + 3]; n++;
      for (let k = 0; k < 3; k++) rgb[k] += rgba[i + k];
    }
  }
  if (!n) continue;
  console.log(`${t.id.padEnd(44)} kind 2 w ${t.w} h ${t.h}`
    + ` meanAlpha ${(alpha / n / 255).toFixed(3)}`
    + ` meanRGB ${JSON.stringify(rgb.map((v) => Math.round(v / n)))}`
    + ` c ${JSON.stringify(t.c)}`);
}
