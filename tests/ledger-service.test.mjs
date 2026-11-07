// The four questions worldd answers from the ledger index. Everything here runs against a temp
// directory holding a hand-built log, a pack baked from it, and a meta.json - because the behaviour that
// matters is what the service does when the artefacts disagree with each other: a stale pack, a pack
// from an older bake, a chunk with more rows than one click should ship.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RECORD_SIZE, readLedger } from '../shared/ledger-format.mjs';
import { CELL_BYTES, CELL_H_BYTES, LEDPACK_HEADER, LEDPACK_VERSION, TL_HEADER, TL_NO_PLAYER, TL_REC, decodeTimeline, readPack } from '../shared/ledger-pack.mjs';
import { buildPack } from '../server/ledger-pack.mjs';
import { LedgerService } from '../server/ledger-service.mjs';

const T0 = 1717174690000;

// Same byte layout the Python writer emits (see tests/ledger-format.test.mjs), with the rows this test
// needs: a break and a place by a player in one chunk, and a kill credited to a source in another.
function logBytes() {
  const parts = [];
  const w32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const w64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); };
  const strings = ['', 'minecraft:air', 'flowing', 'PlayerOne', 'regions_unexplored:mauve_log'];
  parts.push(Buffer.from('LGR1', 'latin1'));
  w32(1);                                  // version
  w32(strings.length);
  for (const s of strings) { const b = Buffer.from(s, 'utf8'); w32(b.length); parts.push(b); }
  w32(1); w32(1); w32(1);                  // worlds:  log id 1 -> strings[1]
  w32(2); w32(1); w32(1); w32(2); w32(2);  // sources: 1 -> air?, 2 -> flowing
  w32(3); w32(1); w32(1); w32(2); w32(1); w32(3); w32(1);   // actions 1..3
  w32(2); w32(1); w32(1); w32(3); w32(4);  // objects: 1 -> air, 3 -> mauve_log
  w32(1); w32(1); w32(3);                  // players: 1 -> PlayerOne
  w64(T0); w64(T0 + 5000);                 // dimension first/last, ms
  w32(3);                                  // records
  const rec = (rowid, t, x, y, z, wid, aid, obj, old, src, pid) => {
    const b = Buffer.alloc(RECORD_SIZE);
    b.writeBigInt64LE(BigInt(rowid), 0);
    b.writeBigInt64LE(BigInt(t), 8);
    b.writeInt32LE(x, 16); b.writeInt32LE(y, 20); b.writeInt32LE(z, 24);
    b.writeUInt32LE(wid, 28); b.writeUInt32LE(aid, 32); b.writeUInt32LE(obj, 36); b.writeUInt32LE(old, 40);
    b.writeUInt32LE(src, 44); b.writeUInt32LE(pid, 48); b.writeUInt32LE(0, 52); b.writeUInt32LE(0, 56);
    b.writeUInt8(0, 60);
    return b;
  };
  parts.push(rec(41, T0 + 1000, -40, 64, -122, 1, 3, 1, 3, 1, 1));  // break in chunk -3,-8
  parts.push(rec(42, T0 + 2000, -41, 64, -122, 1, 2, 3, 1, 1, 1));  // place, same chunk, one block over
  parts.push(rec(43, T0 + 3000, 20, 64, 20, 1, 6, 3, 1, 2, 0));     // kill by a source, chunk 1,1
  return Buffer.concat(parts);
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledsvc-'));
  const logBuf = logBytes();
  const log = path.join(dir, 'actions.bin');
  writeFileSync(log, logBuf);
  const L = readLedger(logBuf);
  // one chunk with a baked ground height, one without, to prove both survive the service rewrite
  const { buf } = buildPack(L, 1, 'region', {
    heightOf: (cx, cz) => (cx === -3 && cz === -8 ? 64 : null),
  });
  const packPath = path.join(dir, 'region.ledpack');
  writeFileSync(packPath, buf);
  const mtime = statSync(packPath).mtimeMs;
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    generated: '2026-01-01T00:00:00.000Z',
    source: { path: log, bytes: logBuf.length, mtimeMs: mtime - 1000 },
    players: [{ id: 1, name: 'PlayerOne' }],
    dims: [{
      dimId: 'minecraft:overworld', dimKey: 'region', pack: 'region.ledpack', worldId: 1,
      rows: 3, cells: 2, first: '2024-05-31 16:58:10', last: '2024-05-31 16:58:13',
    }],
  }));
  return { dir, packPath };
}

test('no ledger is a sentence, not a crash', () => {
  const S = new LedgerService(mkdtempSync(path.join(tmpdir(), 'ledsvc-empty-')));
  assert.equal(S.ready, false);
  assert.equal(S.metaJson().available, false);
  assert.match(S.metaJson().why, /ledger-export/);
  assert.equal(S.cellsBytes('region'), null);
  assert.equal(S.rowsAt('region', 0, 0), null);
  assert.equal(S.topCells('region'), null);
});

test('meta names the players and the dimensions a query can use', () => {
  const { dir } = fixture();
  const S = new LedgerService(dir);
  const m = S.metaJson();
  assert.equal(m.available, true);
  assert.deepEqual(m.players.map((p) => p.name), ['PlayerOne']);
  assert.equal(S.dimInfo('minecraft:overworld').dimKey, 'region', 'a dimension id works');
  assert.equal(S.dimInfo('region').dimKey, 'region', 'and so does our folder key');
  assert.equal(S.dimInfo('minecraft:the_nether'), null, 'a dimension with no pack is no answer');
});

test('the cells answer is the overlay whole: header, cells, and the height plane it stands on', () => {
  const { dir, packPath } = fixture();
  const S = new LedgerService(dir);
  const bytes = S.cellsBytes('region');
  const onDisk = readPack(readFileSync(packPath));
  const head = LEDPACK_HEADER + Buffer.byteLength('region', 'utf8');
  assert.equal(bytes.length, head + onDisk.cellCount * (CELL_BYTES + CELL_H_BYTES),
    '32 B a cell plus the 2 B height, and nothing after it');
  // the browser reads it back with the same reader, which is the only proof the rewrite is legal
  const P = readPack(bytes);
  assert.equal(P.version, LEDPACK_VERSION);
  assert.equal(P.chunkCount, 0, 'the row index is declared absent, so no reader can trust it');
  assert.equal(P.rowCount, 0);
  assert.equal(P.cellCount, 2);
  const hot = P.cell(0);
  assert.deepEqual([hot.cx, hot.cz], [-3, -8]);
  assert.deepEqual(hot.counts, [0, 1, 1, 0, 0, 0], 'one place, one break, indexed by action id');
  assert.equal(hot.playerMask, 0b1, 'the player bit is the log player id minus one');
  assert.equal(hot.y, 64, 'this chunk has a baked ground height');
  assert.equal(P.cell(1).y, null, 'and this one has none, which is a gap, not sea level');
  assert.equal(S.stats.cellsServed, 1);
});

test('the timeline is a separate answer, and the cells slice does not carry it', () => {
  const { dir } = fixture();
  const S = new LedgerService(dir);

  // The overlay layer loads the cells for every dimension it paints. The timeline is 14 B a row, so it
  // has to be askable on its own or every map view would pay for the time machine.
  const tl = S.timelineBytes('region');
  assert.ok(tl && tl.length > 0);
  const TL = decodeTimeline(tl);
  assert.equal(TL.count, 3, 'three rows in this fixture, all in dimension 1');
  assert.deepEqual(TL.dimKey, 'region');

  // Same rows as the point query, and the point query is the one that names the block.
  const rows = S.rowsAt('region', -3, -8, {}).rows;
  assert.equal(rows.length, 2, 'two of them are in chunk -3,-8');
  const cells = readPack(S.cellsBytes('region'));
  assert.equal(cells.tlBytes, null, 'the bytes the overlay downloads declare no timeline');
  assert.equal(tl.length, TL_HEADER + 'region'.length + TL.count * TL_REC,
    'the timeline is self-describing: 28 B header, dim key, 14 B a row');

  // A dimension with no pack has no timeline, and that is a 404 upstream rather than an empty table.
  assert.equal(S.timelineBytes('graveyard:past'), null);
  assert.equal(S.timelineBytes('nope'), null);

  // Time order, and the position each row points at.
  const at = (i) => { const c = cells.cell(TL.cellOf(i)); return [c.cx * 16 + TL.x(i), TL.y(i), c.cz * 16 + TL.z(i)]; };
  assert.deepEqual([at(0), at(1)], [[-40, 64, -122], [-41, 64, -122]], 'break then place, one block apart');
  assert.deepEqual([...TL.player], [0, 0, TL_NO_PLAYER], 'the kill by a source has no player');
  assert.ok(TL.sec[0] < TL.sec[1] && TL.sec[1] < TL.sec[2], 'oldest first');
});

test('a pack older than the export it indexes is refused, not answered with someone else\'s rows', () => {
  const { dir, packPath } = fixture();
  // push the pack into the past: re-exporting without re-baking is the exact mistake this guards
  const at = new Date(Date.now() - 60_000);
  utimesSync(packPath, at, at);
  const S = new LedgerService(dir);
  assert.equal(S.cellsBytes('region'), null);
  assert.equal(S.rowsAt('region', -3, -8), null);
  assert.equal(S.stats.stale, 'region', 'and the refusal is visible in the stats meta ships');
  assert.deepEqual(S.metaJson().stats.stale, 'region', 'so the page can say "re-bake it"');
});

test('a pack this build cannot read says so instead of throwing at the browser', () => {
  const { dir, packPath } = fixture();
  // the realistic bad pack: one baked by the older builder, which had no height plane
  const old = Buffer.alloc(48);
  old.write('LEDPK1  ', 0, 'latin1');
  old.writeUInt32LE(1, 8);
  old.writeUInt32LE('region'.length, 12);
  old.write('region', 40, 'utf8');
  writeFileSync(packPath, old);
  const S = new LedgerService(dir);
  assert.equal(S.cellsBytes('region'), null);
  assert.equal(S.stats.badPack.dimKey, 'region');
  assert.match(S.stats.badPack.why, /version 1 != \d+/, 'named the actual problem');
  assert.deepEqual(S.metaJson().stats.badPack, S.stats.badPack);
});

test('rows for a chunk: oldest first, a break named by the block that left, capped per click', () => {
  const { dir } = fixture();
  const S = new LedgerService(dir);
  const r = S.rowsAt('region', -3, -8, { limit: 10 });
  assert.equal(r.total, 2, 'two rows live in that chunk');
  assert.deepEqual(r.rows.map((x) => x.row), [41, 42], 'time order is the pack\'s job, and it holds');
  assert.equal(r.rows[0].cls, 3);
  assert.equal(r.rows[0].block, 'regions_unexplored:mauve_log',
    'a break row names the block that left, not the air that arrived');
  assert.equal(r.rows[0].now, 'minecraft:air', 'and says what sits there today');
  assert.equal(r.rows[0].player, 'PlayerOne');
  assert.deepEqual([r.rows[0].x, r.rows[0].y, r.rows[0].z], [-40, 64, -122]);

  assert.equal(S.rowsAt('region', -3, -8, { limit: 1 }).rows.length, 1);
  assert.equal(S.rowsAt('region', -3, -8, { limit: 1 }).truncated, true);
  assert.equal(S.rowsAt('region', -3, -8, { cls: 2 }).rows.length, 1, 'kind of action');
  assert.equal(S.rowsAt('region', -3, -8, { player: 1 }).rows.length, 2);
  assert.equal(S.rowsAt('region', -3, -8, { player: 2 }).rows.length, 0, 'a player who was not here');

  const kill = S.rowsAt('region', 1, 1).rows[0];
  assert.equal(kill.cls, 6);
  assert.equal(kill.player, '', 'no player to blame');
  assert.equal(kill.source, 'flowing', 'but the thing that did it is still named');

  assert.deepEqual(S.rowsAt('region', 9, 9), { rows: [], total: 0, truncated: false },
    'a chunk the log never touched is an empty answer, not an error');
  assert.equal(S.metaJson().logLoaded, true, 'the 30 MB log loads once, and only once someone asks');
  assert.equal(new LedgerService(dir).metaJson().logLoaded, false, 'a fresh service has not read it');
});

test('topCells answers "where should I go", and narrows to where I am', () => {
  const { dir } = fixture();
  const S = new LedgerService(dir);
  const all = S.topCells('region', { limit: 10 });
  assert.equal(all.total, 2);
  assert.deepEqual([all.cells[0].cx, all.cells[0].cz], [-3, -8], 'loudest first');
  assert.equal(all.cells[0].n, 2);
  assert.equal(S.topCells('region', { cls: 6 }).cells.length, 1, 'kills only');
  assert.equal(S.topCells('region', { player: 1 }).cells.length, 1, 'one player touched one chunk');
  assert.equal(S.topCells('region', { player: 2 }).cells.length, 0, 'no other player exists here');
  const near = S.topCells('region', { near: { cx: 1, cz: 1, r: 2 } });
  assert.deepEqual(near.cells.map((c) => [c.cx, c.cz]), [[1, 1]], 'a box around where the camera is');
  assert.equal(S.topCells('region', { near: { cx: 1, cz: 1, r: 0 } }).cells.length, 1);
});
