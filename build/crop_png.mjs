// crop a rectangle out of a PNG so a screenshot claim can be looked at up close
import fs from 'node:fs';
import { decodePng, encodePngRgba } from '../server/png.mjs';
const [inF, x, y, w, h, outF] = process.argv.slice(2);
const img = decodePng(fs.readFileSync(inF));
const X = +x, Y = +y, W = +w, H = +h;
if (X < 0 || Y < 0 || X + W > img.w || Y + H > img.h) {
  console.error(`image is ${img.w}x${img.h}; crop ${X},${Y} ${W}x${H} does not fit`);
  process.exit(1);
}
const out = Buffer.alloc(W * H * 4);
for (let j = 0; j < H; j++) {
  const src = ((Y + j) * img.w + X) * 4;
  img.rgba.copy ? img.rgba.copy(out, j * W * 4, src, src + W * 4)
    : out.set(img.rgba.subarray(src, src + W * 4), j * W * 4);
}
fs.writeFileSync(outF, encodePngRgba(W, H, out));
console.log(`${inF} ${img.w}x${img.h} -> ${outF} ${W}x${H} at ${X},${Y}`);
