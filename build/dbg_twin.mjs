import fs from 'node:fs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';
import { buildTimeBlocks, resetMarkerLift } from '../web/js/ledger-blocks.mjs';
import { stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { openPayload } from '../web/js/payload.js';
import { unpack } from '../server/pack-assets.mjs';
const pay = fs.readFileSync('build/assets/geometry.bin');
const assets = unpack(pay.buffer.slice(pay.byteOffset, pay.byteOffset + pay.byteLength));
const ids = stateIdsByName(assets.states);
const nameOf = (id) => assets.states[id - 1]?.name;
const idOf = (n) => { const i = assets.states.findIndex((s) => s.name === n); return i >= 0 ? ids[i] : 0; };
const mk = (name) => {
  const id = idOf(name), st = assets.states[id - 1];
  const sec = new Uint8Array(4096); sec.fill(id & 0xff);
  const buf = new ArrayBuffer(4 + 4 + 4 + 1 + 4 + 4 + 4 + 4 + 4 + 1 + 4 + 16 + 4 + 4 + 2 + 2 + 2 + 2 + 2 + 2);
  const dv = new DataView(buf); let o = 0;
  const u8 = (v) => { dv.setUint8(o, v); o++; }; const u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
  const u32 = (v) => { dv.setUint32(o, v, true); o += 4; }; const i32 = (v) => { dv.setInt32(o, v, true); o += 4; };
  u16(0x4350); u8(3); u8(32); u8(4); u8(0); u32(0); u32(0); u32(0); u32(0); u8(0); u32(0);
  u16(4096); u16(4096); u16(4096); u16(4096); u16(4096); u16(4096); u8(0);
  u32(0x1); u32(0); u16(0); u16(0); u16(0); u16(0); u16(1); u16(1);
  u8(0); u8(1); u16(0); u16(1); u32(1); u16(1); u16(256); u16(256); u16(256); u16(256);
  const view = new Uint8Array(buf);
  return { cx: 0, cz: 0, sections: [{ y: 64, mask: 1n << 1n, data: sec, stateBits: 8, sky: new Uint8Array(2048), blk: new Uint8Array(2048) }],
    yMin: 0, yCount: 24, height: null, payloadBytes: 0, stateAt: (x, y, z) => y >= 64 && y < 80 ? id : 0,
    sectionAt: (y) => (y >= 64 && y < 80 ? { stateAt: (lx, ly, lz) => (ly >= 64 && ly < 80 ? id : 0), sky: null, blk: null, stateBits: 8 } : null),
    surfaceAt: () => 64, skyLight: () => 15, blockLight: () => 0, view: openPayload(buf) };
};
const cellOf = (ci) => ({ cx: 0, cz: 0 });
function tlFor(row) {
  const count = 1, sec = new Uint32Array(count), cell = new Uint16Array(count),
    act = new Uint8Array(count), x = new Uint8Array(count), y = new Uint16Array(count), z = new Uint8Array(count),
    name = new Uint32Array(count), was = new Uint32Array(count), src = new Uint8Array(count);
  sec[0] = 100; cell[0] = 0; act[0] = row.action; x[0] = 9; y[0] = 64; z[0] = 9; name[0] = row.name; was[0] = 0; src[0] = 0;
  return { count, sec, cell, action: act, x, y, z, name, was, src,
    cellOf: (i) => cell[i], xOf: (i) => x[i], yOf: (i) => y[i], zOf: (i) => z[i], secOf: (i) => sec[i],
    actionOf: (i) => act[i], nameOf: (i) => name[i] ?? 0, wasOf: (i) => was[i] ?? 0, nameOfName: (n) => assets.stateNames?.[n] ?? '',
    srcOf: (i) => src[i], byHand: (i) => true };
}
for (const nm of ['minecraft:grass', 'minecraft:stone']) {
  const r = { action: 2, name: idOf(nm) };
  resetMarkerLift();
  const def = buildTimeBlocks(tlFor(r), [cellOf(0)], [0], assets, ids);
  resetMarkerLift();
  const one = buildTimeBlocks(tlFor(r), [cellOf(0)], [0], assets, ids, { twin: 0 });
  console.log(nm, 'models', def.stats.models, 'cubes', def.stats.cubes, 'markerEnd', def.markerEnd[0], 'one', one.markerEnd[0], 'doubled', def.stats.doubled, 'faces', def.stats.faces);
  console.log('  idx', [...def.idx.subarray(0, 24)]);
  console.log('  quads in arm', assets.states[idOf(nm) - 1]?.g?.map((a) => a.length));
}
