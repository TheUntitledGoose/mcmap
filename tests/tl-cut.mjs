// Cut a v4 timeline slice down to an older version, byte for byte (M15.1).
//
// The page still has to read packs baked before the "was" and "source" columns existed, and the only
// honest way to test that is a buffer that really looks like one: same magic, the older header size, the
// table area without the newer table, and rows at the older stride. Retyping a fake header by hand is how
// a back-compat path passes against a file no writer ever produced.
import { TL_HEADER, TL_REC, tlSizes } from '../shared/ledger-pack.mjs';

export function cutTimeline(src, version) {
  const u = src instanceof Uint8Array ? src : new Uint8Array(src);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const from = dv.getUint32(8, true);
  if (from <= version) throw new Error(`cutTimeline: the slice is v${from}, not above v${version}`);
  const count = dv.getUint32(12, true);
  const dimLen = dv.getUint32(24, true);
  const nameBytes = dv.getUint32(32, true);
  const srcBytes = from >= 4 ? dv.getUint32(40, true) : 0;
  const fromHead = tlSizes(from).head, fromRec = tlSizes(from).rec;
  const { head, rec } = tlSizes(version);
  if (rec > fromRec) throw new Error(`cutTimeline: v${version} rows are wider than v${from} rows`);
  // v4 keeps two tables after the dim key; v3/v2 keep the name table; v1 has no name table at all.
  const tables = dimLen + (version >= 2 ? nameBytes : 0) + (version >= 4 ? srcBytes : 0);
  const out = new Uint8Array(head + tables + count * rec);
  out.set(u.subarray(0, head), 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(8, version, true);
  out.set(u.subarray(fromHead, fromHead + tables), head);
  const rowsAt = fromHead + dimLen + nameBytes + srcBytes;
  for (let i = 0; i < count; i++) {
    out.set(u.subarray(rowsAt + i * fromRec, rowsAt + i * fromRec + rec), head + tables + i * rec);
  }
  return out;
}
