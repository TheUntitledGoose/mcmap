// How much of a screenshot is not sky - a cheap "did anything render" number.
import fs from 'node:fs';
import { decodePng } from '../server/png.mjs';
const SKY = [70, 119, 174];
for (const f of process.argv.slice(2)) {
  const im = decodePng(fs.readFileSync(f));
  const n = im.w * im.h; let lit = 0, dark = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (im.rgba[o + 3] < 10) continue;
    const d = Math.abs(im.rgba[o] - SKY[0]) + Math.abs(im.rgba[o + 1] - SKY[1]) + Math.abs(im.rgba[o + 2] - SKY[2]);
    if (d > 90) lit++;
    if (im.rgba[o] + im.rgba[o + 1] + im.rgba[o + 2] < 24) dark++;
  }
  console.log(`${f}  ${im.w}x${im.h}  not-sky ${(100 * lit / n).toFixed(1)}%  black ${(100 * dark / n).toFixed(2)}%`);
}
