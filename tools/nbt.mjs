// Minimal NBT reader (Anvil / 1.20.1). Enough to parse level.dat and chunk NBT.
// Java longs come back as BigInt. TAG_Long_Array -> BigInt64Array.
const TAG_End = 0, TAG_Byte = 1, TAG_Short = 2, TAG_Int = 3, TAG_Long = 4,
      TAG_Float = 5, TAG_Double = 6, TAG_Byte_Array = 7, TAG_String = 8,
      TAG_List = 9, TAG_Compound = 10, TAG_Int_Array = 11, TAG_Long_Array = 12;
const DEC = new TextDecoder('utf8');
const TNAME = ['End','Byte','Short','Int','Long','Float','Double','ByteArray','String','List','Compound','IntArray','LongArray'];
let TRACE = null; // setTrace(true) to log every member with its consumed size
export function setTrace(on) { TRACE = on ? [] : null; }
export function getTrace() { return TRACE; }

export function readNbt(buf, byteOffset = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = byteOffset;
  const type = dv.getUint8(p); p += 1;
  if (type !== TAG_Compound) throw new Error(`root tag is ${type}, expected Compound`);
  const name = readString(dv, p); p += name.size;
  const [value, size] = readPayload(dv, p, type, 1);
  return { name: name.str, value, size: p + size - byteOffset };
}

function readString(dv, p) {
  const len = dv.getUint16(p);
  const str = DEC.decode(new Uint8Array(dv.buffer, dv.byteOffset + p + 2, len));
  return { str, size: 2 + len };
}

function readPayload(dv, p, type, depth = 0) {
  switch (type) {
    case TAG_Byte:   return [dv.getInt8(p), 1];
    case TAG_Short:  return [dv.getInt16(p), 2];
    case TAG_Int:    return [dv.getInt32(p), 4];
    case TAG_Long:   return [dv.getBigInt64(p), 8];
    case TAG_Float:  return [dv.getFloat32(p), 4];
    case TAG_Double: return [dv.getFloat64(p), 8];
    case TAG_Byte_Array: case TAG_Int_Array: case TAG_Long_Array: {
      const n = dv.getInt32(p); p += 4;
      // NOTE: returned size must include the 4-byte element count, or every
      // subsequent member is read 4 bytes early.
      if (type === TAG_Byte_Array)  return [new Uint8Array(dv.buffer, dv.byteOffset + p, n), 4 + n];
      if (type === TAG_Int_Array) {
        const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = dv.getInt32(p + i * 4);
        return [a, 4 + n * 4];
      }
      const out = new BigInt64Array(n);
      for (let i = 0; i < n; i++) out[i] = dv.getBigInt64(p + i * 8);
      return [out, 4 + n * 8];
    }
    case TAG_String: { const s = readString(dv, p); return [s.str, s.size]; }
    case TAG_List: {
      const start = p;
      const elemType = dv.getUint8(p); p += 1;
      const n = dv.getInt32(p); p += 4;
      if (TRACE) TRACE.push({ depth, type: TAG_List, elemType, n, at: p - 5 });
      const out = [];
      for (let i = 0; i < n; i++) { const [v, s] = readPayload(dv, p, elemType, depth + 1); out.push(v); p += s; }
      return [out, p - start];
    }
    case TAG_Compound: {
      const out = {}; let consumed = 0;
      for (;;) {
        const t = dv.getUint8(p); p += 1; consumed++;
        if (t === TAG_End) break;
        const key = readString(dv, p); p += key.size; consumed += key.size;
        const [v, s] = readPayload(dv, p, t, depth + 1); out[key.str] = v; p += s; consumed += s;
        if (TRACE) TRACE.push({ depth, type: t, key: key.str, size: s, at: p - s });
      }
      return [out, consumed];
    }
    default: throw new Error(`unknown tag ${type}`);
  }
}
