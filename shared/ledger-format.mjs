// M12: the world's own block-history log (`DarkRPG/world/ledger.sqlite`) is CoreProtect-shaped:
// 424,599 action rows, 6 players, 85 sources, 22,341 object identifiers. Node 18 on this box has no
// sqlite, and the browser must never see a 96 MB foreign database, so the log is exported once into
// this binary and everything downstream - packs, endpoints, overlays - reads only our bytes.
//
// The writer is tools/ledger-export.py (stdlib sqlite3, opened read-only: the database lives inside
// the irreplaceable world folder and this viewer must never write to it). The layout below is the
// contract between the two; a reader that finds the wrong magic or a short record stops rather than
// mis-reading 424k rows into garbage.

export const LGR_MAGIC = 'LGR1';
export const LGR_VERSION = 1;

// One action record. 64 bytes, little-endian, fixed - see RECORD_FIELDS for the order (the tail byte
// is followed by three pad bytes so a record stays a multiple of 16).
export const RECORD_SIZE = 64;
export const RECORD_FIELDS = [
  ['rowid', 'i64'],        // the ledger's own row id, so a card in the UI can quote something a
  ['timeMs', 'i64'],      // human can paste into CoreProtect
  ['x', 'i32'],
  ['y', 'i32'],
  ['z', 'i32'],
  ['worldId', 'u32'],     // key into worlds
  ['actionId', 'u32'],    // key into actions
  ['objectId', 'u32'],    // what the action is about (block / item / entity identifier)
  ['oldObjectId', 'u32'], // what was there before, when the log knows
  ['sourceId', 'u32'],    // who/what caused it: 'player', 'gravity', 'creeper', 'fluid', ...
  ['playerId', 'u32'],    // 0 = not attributable to a player
  ['blockStrId', 'u32'],  // 0 = none: the block's property string, e.g. {facing:"east"}
  ['extraStrId', 'u32'],  // 0 = none: the log's extra NBT-ish payload, truncated to 256 chars
  ['rolledBack', 'u8'],
];

// What the six action numbers mean. The log names them itself (the `ActionIdentifiers` table), and the
// names check out against the voxels - see build/dbg-ledger-truth.mjs. The row shape is uniform:
//   object_id     the state *after* the action
//   old_object_id the state *before* it
// so a break row records the resulting air and carries the block that vanished in old_object_id.
// Measured over all 424,599 rows: change = block<-block (37,259), place = block<-air (96,291),
// break = air<-block (257,967), insert/remove name items, kill names an entity.
export const ACTION_NAME = {
  1: 'change',
  2: 'place',
  3: 'break',
  4: 'insert',
  5: 'remove',
  6: 'kill',
};

// Which actions leave or take a voxel. Everything else (items moving through containers, entities
// dying) happens *at* a coordinate but does not describe the block there.
export const ACTION_BLOCK_TOUCH = new Set([1, 2, 3]);

// The block someone is responsible for, in the order a UI wants to name it: for a break that is the
// block that went away, for a place/change the block that arrived.
export function blockOf(L, i) {
  const aid = L.actionId(i);
  const id = aid === 3 ? L.oldObjectId(i) : L.objectId(i);
  return L.objects.get(id)?.id ?? '';
}

export function readLedger(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  p = 4;
  if (magic !== LGR_MAGIC) throw new Error(`ledger: magic ${JSON.stringify(magic)} != ${LGR_MAGIC}`);
  const version = dv.getUint32(p, true); p += 4;
  if (version !== LGR_VERSION) throw new Error(`ledger: version ${version} != ${LGR_VERSION}`);

  const dec = new TextDecoder('utf-8');
  const strings = [];
  const nStr = dv.getUint32(p, true); p += 4;
  for (let i = 0; i < nStr; i++) {
    const len = dv.getUint32(p, true); p += 4;
    strings.push(dec.decode(new Uint8Array(buf.buffer, buf.byteOffset + p, len)));
    p += len;
  }
  const table = (fn) => {
    const n = dv.getUint32(p, true); p += 4;
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const id = dv.getUint32(p, true); p += 4;
      out.set(id, fn());
    }
    return out;
  };
  // strOf has to advance the cursor itself: a table entry is (id, string id), and a helper that
  // reads without consuming desynchronised every table after the first.
  const strOf = () => {
    const at = dv.getUint32(p, true); p += 4;
    if (at >= strings.length) throw new Error(`ledger: table string id ${at} >= ${strings.length}`);
    return strings[at];
  };

  const worlds = table(() => ({ id: strOf() }));
  const sources = table(() => ({ id: strOf() }));
  const actions = table(() => ({ id: strOf() }));
  const objects = table(() => ({ id: strOf() }));
  const players = table(() => {
    const name = strOf();
    const firstJoinMs = dv.getBigInt64(p, true); p += 8;
    const lastJoinMs = dv.getBigInt64(p, true); p += 8;
    return { name, firstJoinMs, lastJoinMs };
  });

  const n = dv.getUint32(p, true); p += 4;
  const need = p + n * RECORD_SIZE;
  if (buf.byteLength < need) {
    throw new Error(`ledger: truncated - ${n} records need ${need} bytes, file has ${buf.byteLength}`);
  }
  const recs = new Int32Array(n * 15);
  for (let i = 0; i < n; i++, p += RECORD_SIZE) {
    const o = i * 15;
    // recs is an Int32Array, so a row id beyond i32 would silently truncate. Guard it instead.
    const rid = dv.getBigInt64(p, true);
    if (rid > 2147483647n) throw new Error(`ledger: rowid ${rid} exceeds i32`);
    recs[o] = Number(rid);
    recs[o + 1] = dv.getInt32(p + 8, true);          // timeMs, low word
    recs[o + 2] = dv.getInt32(p + 12, true);         // timeMs, high word
    recs[o + 3] = dv.getInt32(p + 16, true);
    recs[o + 4] = dv.getInt32(p + 20, true);
    recs[o + 5] = dv.getInt32(p + 24, true);
    recs[o + 6] = dv.getInt32(p + 28, true);
    recs[o + 7] = dv.getInt32(p + 32, true);
    recs[o + 8] = dv.getInt32(p + 36, true);
    recs[o + 9] = dv.getInt32(p + 40, true);
    recs[o + 10] = dv.getInt32(p + 44, true);
    recs[o + 11] = dv.getInt32(p + 48, true);
    recs[o + 12] = dv.getInt32(p + 52, true);
    recs[o + 13] = dv.getUint32(p + 56, true);   // extraStrId
    recs[o + 14] = dv.getUint8(p + 60);          // rolledBack
    for (const s of [recs[o + 12], recs[o + 13]]) {
      // A string id past the end of the table means the writer interned after it wrote the table.
      // That happened once; it should be an error, not a name that resolves to undefined later.
      if (s >= strings.length) throw new Error(`ledger: string id ${s} >= ${strings.length}`);
    }
  }
  return {
    version, strings, worlds, sources, actions, objects, players, recs, count: n,
    // Accessors over the flat record array. Named rather than positional because fifteen ints in a
    // row is exactly the kind of thing an off-by-one survives in.
    rowid: (i) => recs[i * 15],
    timeMs: (i) => (recs[i * 15 + 1] >>> 0) + recs[i * 15 + 2] * 4294967296,
    x: (i) => recs[i * 15 + 3],
    y: (i) => recs[i * 15 + 4],
    z: (i) => recs[i * 15 + 5],
    worldId: (i) => recs[i * 15 + 6],
    actionId: (i) => recs[i * 15 + 7],
    objectId: (i) => recs[i * 15 + 8],
    oldObjectId: (i) => recs[i * 15 + 9],
    sourceId: (i) => recs[i * 15 + 10],
    playerId: (i) => recs[i * 15 + 11],
    blockStrId: (i) => recs[i * 15 + 12],
    extraStrId: (i) => recs[i * 15 + 13],
    rolledBack: (i) => recs[i * 15 + 14],
  };
}

// The log stores wall-clock strings ("2024-05-31 16:58:10.260") with no zone, written by a server on
// this machine. We keep epoch-ms since 1970-01-01 UTC and print it back the same way the log does,
// so a time in our UI matches a time in the database text.
export function formatLedgerTime(ms) {
  const d = new Date(ms);
  const two = (v) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}
