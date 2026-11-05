// PNG decode (8/16-bit, gray/RGB/palette/RGBA, tRNS, all 5 filters) + RGBA encode.
// Minecraft textures are almost all 8-bit RGBA or palette; this covers those plus neighbours.
import zlib from 'node:zlib';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(buf) {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  let p = 8, ihdr = null, palette = null, trns = null, idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  const { w, h, depth, color, interlace } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`unsupported color type ${color}`);
  if (depth !== 8 && depth !== 16 && !(color === 3 && depth <= 8)) throw new Error(`unsupported bit depth ${depth}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const sampleBytes = depth === 16 ? 2 : 1;
  const bpp = channels * sampleBytes;
  const bitPacked = color === 3 && depth < 8;
  const out = new Uint8Array(w * h * 4);

  // Adam7: seven sub-images, each filtered normally, scattered back into the full raster.
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  let rp = 0;
  for (const [xoff, yoff, xstep, ystep] of passes) {
    const pw = Math.ceil((w - xoff) / xstep);
    const ph = Math.ceil((h - yoff) / ystep);
    if (pw <= 0 || ph <= 0) continue;
    const inStride = bitPacked ? Math.ceil((pw * depth) / 8) : pw * bpp;
    let prev = new Uint8Array(inStride);
    for (let py = 0; py < ph; py++) {
      const filter = raw[rp++];
      const line = raw.subarray(rp, rp + inStride); rp += inStride;
      const cur = new Uint8Array(inStride);
      for (let x = 0; x < inStride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = line[x];
        switch (filter) {
          case 0: break;
          case 1: v = (v + a) & 255; break;
          case 2: v = (v + b) & 255; break;
          case 3: v = (v + ((a + b) >> 1)) & 255; break;
          case 4: { // Paeth
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
            const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            v = (v + pr) & 255; break;
          }
          default: throw new Error(`bad filter ${filter}`);
        }
        cur[x] = v;
      }
      prev = cur;
      const y = yoff + py * ystep;
      for (let px = 0; px < pw; px++) {
        const x = xoff + px * xstep;
        let r, g, bl, al;
        if (bitPacked) {
          const bitIdx = px * depth, byte = cur[bitIdx >> 3];
          const shift = 8 - depth - (bitIdx & 7);
          const idx = (byte >> shift) & ((1 << depth) - 1);
          [r, g, bl, al] = pal(palette, trns, idx);
        } else if (color === 3) {
          [r, g, bl, al] = pal(palette, trns, cur[px * bpp]);
        } else {
          const o = px * bpp;
          const s = (i) => depth === 16 ? cur[o + i * 2] : cur[o + i];
          if (channels === 1) { r = g = bl = s(0); al = 255; }
          else if (channels === 2) { r = g = bl = s(0); al = s(1); }
          else if (channels === 3) { r = s(0); g = s(1); bl = s(2); al = 255; }
          else { r = s(0); g = s(1); bl = s(2); al = s(3); }
          if (color === 2 && trns) { // truecolor tRNS = exact RGB match -> transparent
            if (r === ((trns[0] << 8) | trns[1]) && g === ((trns[2] << 8) | trns[3]) && bl === ((trns[4] << 8) | trns[5])) al = 0;
          }
        }
        const i4 = (y * w + x) * 4;
        out[i4] = r; out[i4 + 1] = g; out[i4 + 2] = bl; out[i4 + 3] = al;
      }
    }
  }
  return { w, h, rgba: out };
}

// x offset, y offset, x step, y step for each of the seven Adam7 passes
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function pal(palette, trns, idx) {
  if (!palette) return [idx, idx, idx, 255];
  const o = idx * 3;
  const a = trns && idx < trns.length ? trns[idx] : 255;
  return [palette[o], palette[o + 1], palette[o + 2], a];
}

/** Encode RGBA8 as a PNG (filter 0, single IDAT). Correct and small enough. */
export function encodePngRgba(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    rgba.copy ? rgba.copy(raw, p, y * width * 4, (y + 1) * width * 4)
              : raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), p);
    p += width * 4;
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [Buffer.from(SIG)];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    chunks.push(len, t, data, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', idat);
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat(chunks);
}

export let CRC_TABLE = null;
export function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Sample a single pixel (for tint swatches / averages). */
export function pixel(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}
