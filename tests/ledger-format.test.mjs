// The reader in shared/ledger-format.mjs is the only Node-side half of a contract whose writer is
// Python. These tests pin the byte layout with a hand-built buffer so the two halves cannot drift
// apart silently, and they pin that a malformed file is an error rather than 424k rows of garbage.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import {
  ACTION_BLOCK_TOUCH, ACTION_NAME, RECORD_SIZE, blockOf, formatLedgerTime, readLedger,
} from '../shared/ledger-format.mjs';

const build = ({ magic = 'LGR1', version = 1, strings = ['', 'blk', 'src', 'PlayerOne'], cut = 0 } = {}) => {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); };
  parts.push(Buffer.from(magic, 'latin1'));
  u32(version);
  u32(strings.length);
  for (const s of strings) { const b = Buffer.from(s, 'utf8'); u32(b.length); parts.push(b); }
  u32(1); u32(7); u32(1);                    // worlds: id 7 -> strings[1]
  u32(1); u32(8); u32(2);                    // sources: id 8 -> strings[2]
  u32(1); u32(1); u32(1);                    // actions: id 1 -> strings[1]
  u32(1); u32(3); u32(1);                    // objects: id 3 -> strings[1]
  u32(1); u32(9); u32(3);                    // players: id 9 -> strings[3]
  i64(111); i64(222);
  u32(2);                                    // two records
  const rec = (rowid, t, x, y, z, w, a, o, oo, s, p, bs, es, rb) => {
    const b = Buffer.alloc(RECORD_SIZE);
    b.writeBigInt64LE(BigInt(rowid), 0);
    b.writeBigInt64LE(BigInt(t), 8);
    b.writeInt32LE(x, 16); b.writeInt32LE(y, 20); b.writeInt32LE(z, 24);
    b.writeUInt32LE(w, 28); b.writeUInt32LE(a, 32); b.writeUInt32LE(o, 36); b.writeUInt32LE(oo, 40);
    b.writeUInt32LE(s, 44); b.writeUInt32LE(p, 48); b.writeUInt32LE(bs, 52); b.writeUInt32LE(es, 56);
    b.writeUInt8(rb, 60);
    return b;
  };
  parts.push(rec(41, 1717174690260, -40, 64, -122, 7, 3, 1, 3, 8, 9, 0, 0, 0));
  parts.push(rec(42, 1717174691743, 5, -3, -7, 7, 2, 3, 1, 2, 0, 2, 2, 1));
  let buf = Buffer.concat(parts);
  if (cut) buf = buf.subarray(0, buf.length - cut);
  return buf;
};

test('a record is 64 bytes and every field lands where the Python writer puts it', () => {
  const L = readLedger(build());
  assert.equal(L.count, 2);
  assert.equal(L.rowid(0), 41);
  assert.equal(L.timeMs(0), 1717174690260);
  assert.deepEqual([L.x(0), L.y(0), L.z(0)], [-40, 64, -122]);
  assert.deepEqual([L.worldId(0), L.actionId(0), L.sourceId(0), L.playerId(0)], [7, 3, 8, 9]);
  assert.deepEqual([L.objectId(0), L.oldObjectId(0)], [1, 3]);
  assert.equal(L.rolledBack(0), 0);
  // negative coordinates and a time past 2^32 seconds both have to survive
  assert.deepEqual([L.x(1), L.y(1), L.z(1)], [5, -3, -7]);
  assert.equal(L.rolledBack(1), 1);
  assert.equal(L.playerId(1), 0);
  assert.equal(L.timeMs(1), 1717174691743);
});

test('tables resolve to names, and a name is looked up by the log id, not by array position', () => {
  const L = readLedger(build());
  assert.equal(L.worlds.get(7).id, 'blk');
  assert.equal(L.sources.get(8).id, 'src');
  assert.equal(L.players.get(9).name, 'PlayerOne');
  assert.equal(Number(L.players.get(9).firstJoinMs), 111);
  assert.equal(Number(L.players.get(9).lastJoinMs), 222);
});

test('the log names its actions, and the labels agree with the row shape it writes', () => {
  // Measured against the real database: place rows are block<-air, break rows are air<-block, change
  // rows are block<-block. A UI that called action 3 a "place" would blame the wrong person.
  assert.deepEqual(ACTION_NAME, {
    1: 'change', 2: 'place', 3: 'break', 4: 'insert', 5: 'remove', 6: 'kill',
  });
  assert.equal(ACTION_BLOCK_TOUCH.has(3), true);
  assert.equal(ACTION_BLOCK_TOUCH.has(4), false);
});

test('a break is named by the block that left, a place by the block that arrived', () => {
  const L = readLedger(build());
  assert.equal(blockOf(L, 0), 'blk', 'break row 0: old_object_id is the block that broke');
  assert.equal(blockOf(L, 1), 'blk', 'place row 1: object_id is the block placed');
});

test('times print the way the database prints them, so a card can be checked by hand', () => {
  assert.equal(formatLedgerTime(1717174690260), '2024-05-31 16:58:10');
});

test('a wrong magic, a truncated tail, or a string id past the table are all errors', () => {
  assert.throws(() => readLedger(build({ magic: 'XXXX' })), /magic/);
  assert.throws(() => readLedger(build({ version: 99 })), /version/);
  assert.throws(() => readLedger(build({ cut: 20 })), /truncated/);
  assert.throws(() => readLedger(build({ strings: [''] })), /string id/);
});

test('the exported file, when present, still matches what sqlite said', (t) => {
  const p = 'build/ledger/actions.bin';
  if (!existsSync(p)) return t.skip('not exported yet');
  if (statSync(p).size > 200 * 1024 * 1024) return t.skip('absurdly large');
  const L = readLedger(readFileSync(p));
  // Row 0 of the real log, checked against the database directly.
  assert.equal(L.rowid(0), 1);
  assert.equal(L.timeMs(0), 1717174690260);
  assert.deepEqual([L.x(0), L.y(0), L.z(0)], [136, -16, 156]);
  const tally = new Map();
  for (let i = 0; i < L.count; i++) tally.set(L.actionId(i), (tally.get(L.actionId(i)) ?? 0) + 1);
  assert.deepEqual([...tally].sort(), [[1, 37259], [2, 96320], [3, 257967], [4, 4712], [5, 4713], [6, 23628]]);
  assert.equal(L.count, 424599);
  // Nothing may point outside the tables it names.
  for (let i = 0; i < L.count; i++) {
    assert.ok(L.worlds.has(L.worldId(i)), `row ${i} world ${L.worldId(i)}`);
    assert.ok(L.objects.has(L.objectId(i)), `row ${i} object ${L.objectId(i)}`);
    assert.ok(L.playerId(i) === 0 || L.players.has(L.playerId(i)), `row ${i} player`);
  }
});
