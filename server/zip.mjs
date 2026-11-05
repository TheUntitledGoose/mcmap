// Minimal read-only ZIP reader (jar = zip). Avoids spawning unzip per file.
// Supports stored(0) + deflate(8), and the zip64 extra field where sizes are 0xFFFFFFFF.
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

export class ZipFile {
  constructor(path) {
    this.path = path;
    this.buf = fs.readFileSync(path);
    this.entries = new Map();
    this.#parseCentralDirectory();
  }

  #findEocd() {
    const maxBack = Math.min(this.buf.length, 66_000);
    for (let i = this.buf.length - 4; i > this.buf.length - maxBack; i--) {
      if (this.buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error(`no EOCD in ${this.path}`);
  }

  #parseCentralDirectory() {
    const eocd = this.#findEocd();
    let count = this.buf.readUInt16LE(eocd + 10);
    let cdOffset = this.buf.readUInt32LE(eocd + 16);
    // zip64 EOCD locator right before the EOCD
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (this.buf.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(this.buf.readBigUInt64LE(loc + 8));
        count = Number(this.buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(this.buf.readBigUInt64LE(z64 + 48));
      }
    }
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (this.buf.readUInt32LE(p) !== CD_SIG) throw new Error(`bad central dir entry at ${p} in ${this.path}`);
      const method = this.buf.readUInt16LE(p + 10);
      const compSize = this.buf.readUInt32LE(p + 20);
      const uncompSize = this.buf.readUInt32LE(p + 24);
      const nameLen = this.buf.readUInt16LE(p + 28);
      const extraLen = this.buf.readUInt16LE(p + 30);
      const commentLen = this.buf.readUInt16LE(p + 32);
      const localOff = this.buf.readUInt32LE(p + 42);
      const name = this.buf.toString('utf8', p + 46, p + 46 + nameLen);
      let cs = compSize, lo = localOff;
      if (cs === 0xffffffff || lo === 0xffffffff) {
        // zip64 extra field 0x0001: uncompressed, compressed, local header offset
        let q = p + 46 + nameLen;
        const extraEnd = q + extraLen;
        while (q + 4 <= extraEnd) {
          const id = this.buf.readUInt16LE(q), sz = this.buf.readUInt16LE(q + 2);
          if (id === 0x0001) {
            let r = q + 4;
            if (uncompSize === 0xffffffff) r += 8;
            if (compSize === 0xffffffff) { cs = Number(this.buf.readBigUInt64LE(r)); r += 8; }
            if (localOff === 0xffffffff) lo = Number(this.buf.readBigUInt64LE(r));
            break;
          }
          q += 4 + sz;
        }
      }
      if (!name.endsWith('/')) this.entries.set(name, { method, cs, lo });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  names() { return this.entries.keys(); }
  has(name) { return this.entries.has(name); }
  sizes(name) { const n = this.entries.get(name); return n ? this.#data(n).length : -1; }

  #data(e) {
    const p = e.lo;
    if (this.buf.readUInt32LE(p) !== LFH_SIG) throw new Error(`bad local header for ${e.cs}`);
    const nameLen = this.buf.readUInt16LE(p + 26);
    const extraLen = this.buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = this.buf.subarray(start, start + e.cs);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported zip method ${e.method}`);
  }

  /** -> Buffer or null */
  read(name) {
    const e = this.entries.get(name);
    return e ? Buffer.from(this.#data(e)) : null;
  }
  readText(name) { const b = this.read(name); return b ? b.toString('utf8') : null; }
  close() { this.buf = null; this.entries.clear(); }
}
