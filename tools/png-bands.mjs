// Where on the screen do the two renders differ? Vertical bands, top of the frame (far) to bottom
// (near). This is how you tell "the coarse layer paints the horizon" (fine) from "the coarse layer
// paints the ground right in front of the camera" (a bug), without squinting at two screenshots.
//
//   node build/ab_rows.mjs build/ab_def.png build/ab_nolod_1.png [threshold]
import fs from 'node:fs';
import { decodePng } from '../server/png.mjs';

const [a, b, thr] = process.argv.slice(2);
const T = +(thr ?? 10);
const A = decodePng(fs.readFileSync(a)), B = decodePng(fs.readFileSync(b));
if (A.w !== B.w || A.h !== B.h) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
const BANDS = 8;
const rows = Array.from({ length: BANDS }, () => ({ n: 0, ch: 0, sum: 0 }));
for (let y = 0; y < A.h; y++) {
  const band = Math.min(BANDS - 1, Math.floor((y / A.h) * BANDS));
  const r = rows[band];
  for (let x = 0; x < A.w; x++) {
    const i = (y * A.w + x) * 4;
    const d = Math.max(Math.abs(A.rgba[i] - B.rgba[i]), Math.abs(A.rgba[i + 1] - B.rgba[i + 1]), Math.abs(A.rgba[i + 2] - B.rgba[i + 2]));
    r.n++; r.sum += d; if (d > T) r.ch++;
  }
}
console.log(`bands top(far) -> bottom(near), threshold |d| > ${T}, ${A.w}x${A.h}`);
rows.forEach((r, i) => {
  const y0 = Math.round((i / BANDS) * A.h), y1 = Math.round(((i + 1) / BANDS) * A.h);
  console.log(`  band ${i} y ${String(y0).padStart(4)}-${String(y1).padStart(4)}  changed ${String(100 * r.ch / r.n).padStart(5)}%  mean|d| ${r.sum / r.n}`);
});
