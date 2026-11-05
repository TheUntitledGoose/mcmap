// Anvil region file reader: 4KiB header, chunk streams, packed long-array access.
import fs from 'node:fs';

export const SECTOR = 4096;

export class RegionFile {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
    this.header = Buffer.alloc(SECTOR);
    fs.readSync(this.fd, this.header, 0, SECTOR, 0);
  }
  /** [offsetInSectors, byteLength] for local chunk (x,z) 0..31, or null. */
  entry(x, z) {
    const i = (z << 5) | x;
    const v = this.header.readUInt32BE(i * 4);
    if (!v) return null;
    return [(v >>> 8) * SECTOR, (v & 0xff) * SECTOR];
  }
  readChunkNbtBytes(x, z) {
    const e = this.entry(x, z);
    if (!e) return null;
    const [off, len] = e;
    const buf = Buffer.alloc(len);
    fs.readSync(this.fd, buf, 0, len, off);
    // 4-byte length, 1-byte compression type (2 = zlib), then deflate stream
    const comp = buf[4];
    if (comp !== 2) throw new Error(`unsupported compression type ${comp}`);
    return buf.subarray(5, 4 + buf.readUInt32BE(0));
  }
  countChunks() {
    let n = 0;
    for (let i = 0; i < 1024; i++) if (this.header.readUInt32BE(i * 4)) n++;
    return n;
  }
  close() { fs.closeSync(this.fd); }
}

/**
 * 1.16.220+ bit packing: entries MAY cross long boundaries.
 * bits may exceed 32/64 boundaries; BigInt keeps this honest (see notes in PLAN
 * for the faster two-word Int32 path used at runtime).
 */
export function stateAtBigInt(longs, bits, index) {
  const bit = BigInt(index) * BigInt(bits);
  const li = Number(bit / 64n);
  const off = Number(bit % 64n);
  let v = longs[li] >> BigInt(off);
  if (off + bits > 64 && li + 1 < longs.length) v |= longs[li + 1] << BigInt(64 - off);
  return v & ((1n << BigInt(bits)) - 1n);
}

/** Palette size 1 (single-value section) => bits = 0, every index maps to palette[0]. */
export function bitsFor(paletteLength, oldFormat = false) {
  if (paletteLength <= 1) return oldFormat ? 4 : 0;
  let bits = 0, n = paletteLength - 1;
  while (n > 0) { bits++; n >>>= 1; }
  return Math.max(bits, 4); // legacy floor of 4 bits in pre-1.16.220 data
}
