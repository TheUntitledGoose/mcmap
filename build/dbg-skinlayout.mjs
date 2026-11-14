// Where the parts of a player skin actually are, measured over thousands of real skins.
//
//   node build/dbg-skinlayout.mjs [--n 600] [--dir <assets/skins>] [--files a.png b.png]
//
// Why measure instead of remember: the 64x64 skin layout is a cross per part, and the memory of which
// origin belongs to which part (jacket vs sleeve, left arm vs left leg, second layer vs first) is exactly
// the kind of thing that produces a plausible body with someone's trousers on their shoulder. A real skin
// answers it: the regions a layout does not use stay transparent, and the ones it does use are painted in
// nearly every skin. Averaged over hundreds of skins, the crosses show up as solid shapes and the origins
// can be read off the picture.
//
// This uses the local client skin cache (`<.minecraft>/assets/skins/<xx>/<hash>`), which is already on
// this machine - no network, and nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from '../server/png.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const N = +arg('n', 600);
const LOCAL = arg('dir', process.env.APPDATA
  ? path.join(process.env.APPDATA, '.minecraft', 'assets', 'skins') : '');
// Only real filenames: `--n 260` must not read "260" as a file.
const FILES = (() => {
  const out = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { i++; continue; }
    out.push(a[i]);
  }
  return out;
})();

const files = [];
if (FILES.length) files.push(...FILES);
else {
  for (const sub of fs.readdirSync(LOCAL)) {
    const d = path.join(LOCAL, sub);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) files.push(path.join(d, f));
    if (files.length > N * 3) break;
  }
  // Deterministic sample, so two runs print the same picture.
  files.sort();
  const step = Math.max(1, Math.floor(files.length / N));
  const sample = [];
  for (let i = 0; i < files.length && sample.length < N; i += step) sample.push(files[i]);
  files.length = 0; files.push(...sample);
}

const W = 64, H = 64;
const painted = new Float64Array(W * H);
const opaque = new Float64Array(W * H);
let used = 0, skipped = 0;
for (const f of files) {
  let png;
  try { png = decodePng(fs.readFileSync(f)); } catch { skipped++; continue; }
  if (png.w !== 64 || png.h !== 64) { skipped++; continue; }
  used++;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * png.w + x) * 4;
      const a = png.rgba[i + 3];
      if (a > 0) painted[y * W + x]++;
      if (a > 200) opaque[y * W + x]++;
    }
  }
}

console.log(`skins sampled: ${used} (skipped ${skipped}: not 64x64 or undecodable)`);
console.log('one character per PIXEL;  # >=90% painted, + 60-90, : 25-60, . 5-25, blank <5%');
console.log('    ' + '0123456789'.repeat(6).slice(0, W));
for (let y = 0; y < H; y++) {
  let row = `y${String(y).padStart(2)} `;
  for (let x = 0; x < W; x++) {
    const f = painted[y * W + x] / Math.max(1, used);
    row += f >= 0.9 ? '#' : f >= 0.6 ? '+' : f >= 0.25 ? ':' : f >= 0.05 ? '.' : ' ';
  }
  console.log(row);
}
