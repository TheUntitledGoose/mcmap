import fs from 'node:fs';
import { decodePng } from '../server/png.mjs';
const img = decodePng(fs.readFileSync(process.argv[2]));
const at = (x, y) => { const i = (y * img.w + x) * 4; return img.rgba[i] + ',' + img.rgba[i + 1] + ',' + img.rgba[i + 2]; };
for (let y = 200; y <= 790; y += 45) {
  const row = [150, 400, 640, 900, 1150].map((x) => at(x, y));
  console.log(String(y).padStart(4), row.join(' | '));
}
