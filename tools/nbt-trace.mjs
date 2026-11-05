// Trace NBT structure with absolute byte offsets to find parse desyncs.
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const raw = fs.readFileSync(file);
// level.dat is gzip; chunk streams inside regions are zlib
const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let p = 0, maxDepth = Number(process.argv[3] ?? 2);

function str(depth) {
  const n = dv.getUint16(p);
  const s = buf.toString('utf8', p + 2, p + 2 + n);
  if (n > 512) throw new Error(`absurd string length ${n} at ${p}`);
  p += 2 + n;
  return s;
}
const TYPE_NAME = ['End','Byte','Short','Int','Long','Float','Double','ByteArray','String','List','Compound','IntArray','LongArray'];

function skip(t, depth) {
  switch (t) {
    case 1: p += 1; break;
    case 2: p += 2; break;
    case 3: p += 4; break;
    case 4: p += 8; break;
    case 5: p += 4; break;
    case 6: p += 8; break;
    case 7: { const n = dv.getInt32(p); p += 4 + n; break; }
    case 8: str(depth); break;
    case 11: { const n = dv.getInt32(p); p += 4 + 4 * n; break; }
    case 12: { const n = dv.getInt32(p); p += 4 + 8 * n; break; }
    case 9: {
      const et = dv.getUint8(p); p += 1;
      const n = dv.getInt32(p); p += 4;
      if (depth < maxDepth && !(et === 0 && n === 0)) {
        console.log(`${'  '.repeat(depth)}LIST<${TYPE_NAME[et] ?? et}> n=${n} @${p - 5}`);
      }
      for (let i = 0; i < n; i++) {
        if (et === 0) throw new Error(`list<End> with n=${n} at ${p}`);
        skip(et, depth + 1);
      }
      break;
    }
    case 10: {
      let i = 0;
      for (;;) {
        const t = dv.getUint8(p); p += 1;
        if (t === 0) break;
        if (t > 12) throw new Error(`bad tag ${t} at ${p - 1} (prev member key context)`);
        const k = str(depth);
        if (depth < maxDepth) console.log(`${'  '.repeat(depth)}${TYPE_NAME[t] ?? '?'} ${JSON.stringify(k)} @${p}`);
        skip(t, depth + 1);
        i++;
        if (i > 5000) throw new Error('too many members, desync');
      }
      break;
    }
    default: throw new Error(`bad tag ${t} at ${p}`);
  }
}

console.log('file size', buf.length, 'root tag', TYPE_NAME[dv.getUint8(0)]);
p = 1; str(0);
try {
  skip(10, 0);
  console.log(`\nOK consumed ${p} of ${buf.length} (trailing ${buf.length - p})`);
} catch (e) {
  console.log('\nDESYNC:', e.message);
  const at = Number(/at (\d+)/.exec(e.message)?.[1] ?? p);
  console.log('context around', at);
  const from = Math.max(0, at - 48);
  console.log(buf.subarray(from, at + 32).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
  console.log([...buf.subarray(Math.max(0, at - 16), at + 8)].map(x => x.toString(16).padStart(2, '0')).join(' '));
}
