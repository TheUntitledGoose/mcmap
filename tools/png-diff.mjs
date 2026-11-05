#!/usr/bin/env node
// Compare rendered screenshots numerically, so "is the new shading better?" has an answer that
// does not depend on squinting. Reads PNGs directly (no dependencies): 8-bit RGB/RGBA, non
// interlaced, which is all our own screenshots ever are.
//
//   node tools/png-diff.mjs a.png b.png
//
// Per image: mean luminance, how burnt the darkest pixels are, and mean |gradient| between
// horizontally adjacent pixels (a rough "is the texture mushy or crunchy" measure).
// Between images: mean/max channel difference and the share of pixels that changed.
import fs from 'node:fs';
import zlib from 'node:zlib';

function decode(path) {
  const b = fs.readFileSync(path);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let p = 8, w = 0, h = 0, ct = 0, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`${path}: bit depth ${data[8]} unsupported`);
      ct = data[9];
      if (data[12]) throw new Error(`${path}: interlaced unsupported`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : (() => { throw new Error(`color type ${ct}`); })();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, bb = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, px: out };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function stats(img) {
  const { w, h, bpp, px } = img;
  let sum = 0, grad = 0, gcount = 0, burnt = 0, n = 0, dark = 0;
  const hist = new Array(8).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w * bpp + x * bpp;
      const l = lum(px[i], px[i + 1], px[i + 2]);
      sum += l; n++;
      if (l < 32) burnt++;
      if (l < 64) dark++;
      hist[Math.min(7, (l / 32) | 0)]++;
      if (x + 1 < w) {
        const j = i + bpp;
        grad += Math.abs(l - lum(px[j], px[j + 1], px[j + 2]));
        gcount++;
      }
    }
  }
  return {
    meanLum: +(sum / n).toFixed(1),
    gradient: +(grad / gcount).toFixed(2),
    pctBelow32: +(100 * burnt / n).toFixed(2),
    pctBelow64: +(100 * dark / n).toFixed(2),
    histogram: hist.map((v) => +(100 * v / n).toFixed(1)),
  };
}

const [a, b] = process.argv.slice(2);
for (const f of [a, b]) {
  const img = decode(f);
  console.log(f, `${img.w}x${img.h}`, JSON.stringify(stats(img)));
}
if (a && b) {
  const A = decode(a), B = decode(b);
  if (A.w !== B.w || A.h !== B.h) { console.log('size mismatch, no diff'); process.exit(0); }
  let diff = 0, max = 0, changed = 0, n = 0;
  for (let i = 0; i < A.px.length; i += A.bpp) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(A.px[i + k] - B.px[i + k]);
      diff += d; if (d > max) max = d;
    }
    const l1 = lum(A.px[i], A.px[i + 1], A.px[i + 2]), l2 = lum(B.px[i], B.px[i + 1], B.px[i + 2]);
    if (Math.abs(l1 - l2) > 4) changed++;
    n++;
  }
  console.log('diff', JSON.stringify({
    meanAbsPerChannel: +(diff / (n * 3)).toFixed(2),
    max,
    pctPixelsChanged: +(100 * changed / n).toFixed(1),
  }));
}
