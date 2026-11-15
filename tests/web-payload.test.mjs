// The browser payload reader, on its own: the fingerprint 9.6's mesh key is built from.
//
// The server writer and the byte layout are held by tests/chunk-payload.test.mjs; this file holds the
// one thing the viewer needs that the writer does not provide: a stable fingerprint of the frame, so
// "the store refetched this chunk" can be answered with "same ground" or "different ground".
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';

import { openChunk, openBatch, frameDigest, declaredTableHash, expectTableHash, BATCH_MAGIC_V1 } from '../web/js/payload.js';
import { stateTableHash, BATCH_HEADER_V1 } from '../shared/chunk-format.mjs';
import { decodeChunk, packChunk, buildStateIds } from '../server/chunk-payload.mjs';
import { packBatch } from '../server/world-service.mjs';
import { RegionFile } from '../tools/region.mjs';
import { readNbt } from '../tools/nbt.mjs';

const WORLD = 'DarkRPG/world';
const haveWorld = existsSync(`${WORLD}/region/r.0.0.mca`);
const censusKeys = () => JSON.parse(readFileSync('build/census.json', 'utf8')).states.map((s) => s.key);

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function realChunk(x = 3, z = 3) {
  const rgn = new RegionFile(`${WORLD}/region/r.0.0.mca`);
  const raw = rgn.readChunkNbtBytes(x, z);
  rgn.close();
  assert.ok(raw, 'chunk stream missing');
  return readNbt(zlib.inflateSync(raw)).value;
}

test('a chunk frame carries a fingerprint of its bytes, stable across a refetch', { skip: !haveWorld }, () => {
  // The key asks "is this the same ground", and the viewer has to be able to say yes after panning away
  // and back: the refetch is a different object holding the same world. So the digest may depend on the
  // frame bytes and nothing else.
  const stateIds = buildStateIds(censusKeys());
  const bytes = packChunk(decodeChunk(realChunk(3, 3), stateIds));
  const again = packChunk(decodeChunk(realChunk(3, 3), stateIds));

  const a = openChunk(toArrayBuffer(bytes));
  const b = openChunk(toArrayBuffer(again));
  const c = openChunk(toArrayBuffer(Buffer.from(bytes)));
  assert.ok(a.digest >= 1 && b.digest >= 1, 'a real chunk fingerprints to a non-zero number');
  assert.equal(a.digest, b.digest, 'the same chunk decoded twice is the same ground');
  assert.equal(a.digest, c.digest, 'and it survives a fresh copy of the buffer');

  const other = openChunk(toArrayBuffer(packChunk(decodeChunk(realChunk(4, 3), stateIds))));
  assert.notEqual(a.digest, other.digest, 'different ground, different fingerprint');

  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 6] ^= 0xff;
  assert.notEqual(openChunk(toArrayBuffer(flipped)).digest, a.digest, 'an edit has to change it');
});

// A container that claims nothing: the layout from before a batch could name a state table.
function packBatchV1(frames) {
  let total = BATCH_HEADER_V1;
  for (const f of frames) total += 4 + ((f.length + 3) & ~3);
  const out = Buffer.alloc(total);
  out.write(BATCH_MAGIC_V1, 0, 'ascii');
  out.writeUInt32LE(frames.length, BATCH_HEADER_V1 - 4);
  let p = BATCH_HEADER_V1;
  for (const f of frames) { out.writeUInt32LE(f.length, p); p += 4; f.copy(out, p); p += (f.length + 3) & ~3; }
  return out;
}

test('a batch names the state table its ids number against, and the reader refuses another one', { skip: !haveWorld }, () => {
  // Two saves on one box can hold the same block under different ids: measured on the deployed pair,
  // `minecraft:dirt` is id 6 in one save's table and id 14 in the other's, while `minecraft:stone` is 4
  // in both. So a payload that came from the wrong save is not noise - it is a plausible wrong world,
  // drawn with the right textures. The container names the table it numbered against, and this reader
  // is the thing that says no.
  const keys = censusKeys();
  const f1 = packChunk(decodeChunk(realChunk(3, 3), buildStateIds(keys)));
  const mine = stateTableHash(keys);
  const other = stateTableHash([...keys].reverse());
  assert.notEqual(mine, other, 'renumbering a table has to change the number it hashes to');

  const batch = toArrayBuffer(packBatch([f1], mine));
  assert.equal(declaredTableHash(batch), mine, 'the container carries the claim');
  assert.equal(openBatch(batch, mine).length, 1, 'read by the page that holds that table: fine');
  assert.throws(() => openBatch(batch, other),
    (e) => e.tableMismatch === true && e.declared === mine && e.expected === other,
    'read by a page holding a page holding the other table: refused, naming both tables');

  // A pre-v2 container claims nothing, so there is nothing to refuse - and a page that has not loaded
  // an atlas yet asks nothing of a container it is handed.
  const old = toArrayBuffer(packBatchV1([f1]));
  assert.equal(declaredTableHash(old), 0, 'an old container makes no claim');
  assert.equal(openBatch(old, mine).length, 1, 'no claim, no refusal');

  // main.js sets the module expectation once, and the stores call openBatch(ab) with no argument.
  expectTableHash(mine);
  assert.equal(openBatch(batch).length, 1, 'the page reading its own table accepts its own answer');
  expectTableHash(other);
  assert.throws(() => openBatch(batch), (e) => e.tableMismatch === true, 'and the store path refuses');
  expectTableHash(0);
});

test('a frame that is a subarray of a batch fingerprints the same as the frame alone', { skip: !haveWorld }, () => {
  // The store opens batches in place, so the digest must not depend on where the frame sits in the
  // buffer - otherwise every batched chunk would look different from the same chunk fetched singly.
  const stateIds = buildStateIds(censusKeys());
  const f1 = packChunk(decodeChunk(realChunk(3, 3), stateIds));
  const f2 = packChunk(decodeChunk(realChunk(4, 3), stateIds));
  const single = openChunk(toArrayBuffer(f1));
  const batch = packBatch([f1, f2]);        // the real container writer, not hand-rolled bytes
  const [b1, b2] = openBatch(toArrayBuffer(batch));
  assert.equal(b1.digest, single.digest, 'same frame, batched or not');
  assert.equal(b1.digest, frameDigest(new Uint8Array(toArrayBuffer(f1))), 'and equal to the raw frame');
  assert.notEqual(b2.digest, b1.digest, 'the two chunks in the batch stay distinct');
});
