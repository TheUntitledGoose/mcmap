// Does the MESHER actually drop the house wall when the playhead undoes it? Browser mesher, real chunk
// bytes, real timeline, no scene / ray / GPU in the way: it counts quad CORNERS whose position lies
// inside one named voxel. Present world first, then the same chunk with the playhead's edits applied.
import fs from 'node:fs';

import { Assets } from '../web/js/assets.js';
import { openChunk, withAccessors } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { applyEdits, editsForCell, stateIdsByName } from '../web/js/ledger-terrain.mjs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { readPack, decodeTimeline, tlX, tlY, tlZ } from '../shared/ledger-pack.mjs';

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});

const HCX = -4, HCZ = -9;
const BX = -59, BY = 72, BZ = -130;
const PH_SEC = 100948;

const packFile = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(packFile);
const tl = decodeTimeline(ab(packFile.subarray(pack.tlBytes[0], pack.tlBytes[1])));
console.log('timeline v' + tl.version, 'rows', tl.count, 'cells', pack.cellCount);

let ci = -1;
for (let i = 0; i < pack.cellCount; i++) {
  const c = pack.cell(i);
  if (c.cx === HCX && c.cz === HCZ) { ci = i; break; }
}
const rows = [];
for (let r = 0; r < tl.count; r++) if (tl.cell[r] === ci) rows.push(r);
console.log('cell', ci, 'rows', rows.length);

const byName = stateIdsByName(atlas.states);
const airId = atlas.states.findIndex((s) => s.k === 'minecraft:air') + 1;
const got = editsForCell(tl, Int32Array.from(rows), PH_SEC, (nm) => byName.get(nm) ?? 0, 4096);
console.log('edits', got.edits.length / 2, 'break', got.breakRows, 'place', got.placeRows,
  'change', got.changeRows, 'other', got.otherRows, 'unknown', got.unknown, 'trunc', got.truncated);

const pack3 = (x, y, z) => (x & 15) | ((z & 15) << 4) | ((y + 4096) << 8);
const target = pack3(BX, BY, BZ);
let foundEdit = null;
for (let i = 0; i < got.edits.length; i += 2) {
  if (got.edits[i] === target) {
    const st = got.edits[i + 1];
    foundEdit = st === 0 ? 'air' : (atlas.states[st - 1]?.k ?? String(st));
  }
}
console.log('voxel', BX, BY, BZ, 'packed', target, 'edit ->', foundEdit,
  'decoded', tlX(target), tlY(target), tlZ(target));

function halo(patched) {
  const map = new Map();
  for (const dz of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    const cx = HCX + dx, cz = HCZ + dz;
    const b = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!b) continue;
    let ch = openChunk(ab(b));
    if (patched && cx === HCX && cz === HCZ) ch = applyEdits(ch, got.edits, { withAccessors, airId });
    map.set(`${cx},${cz}`, ch);
  }
  return map;
}

function cornersAt(streams) {
  const eps = 1e-3;
  const perPass = [];
  let n = 0;
  for (let p = 0; p < streams.length; p++) {
    const s = streams[p];
    let hits = 0;
    for (let v = 0; v < s.count; v++) {
      const x = s.position[v * 3], y = s.position[v * 3 + 1], z = s.position[v * 3 + 2];
      if (x < BX - eps || x > BX + 1 + eps) continue;
      if (y < BY - eps || y > BY + 1 + eps) continue;
      if (z < BZ - eps || z > BZ + 1 + eps) continue;
      hits++;
    }
    perPass.push(hits);
    n += hits;
  }
  return { corners: n, perPass };
}

for (const label of ['present', 'undo']) {
  const map = halo(label === 'undo');
  const ch = map.get(`${HCX},${HCZ}`);
  const lx = ((BX % 16) + 16) % 16, lz = ((BZ % 16) + 16) % 16;
  const st = ch.stateAt(lx, BY, lz);
  const at = (cx, cz, x, y, z) => {
    const c = map.get(`${cx + (x >> 4)},${cz + (z >> 4)}`);
    if (!c) return -1;
    const id = c.stateAt(x & 15, y, z & 15);
    return id === 0 ? -1 : id - 1;
  };
  const { streams, stats } = meshChunk(assets, ch, at, { ao: 0.42, index: 1 });
  console.log(label, '| voxel id', st, atlas.states[st - 1]?.k ?? '?',
    '| corners in voxel', JSON.stringify(cornersAt(streams)),
    '| quads', stats.quads, 'verts', stats.verts ?? streams[0].count,
    '| culled', stats.culled, 'buried', stats.buried, 'dark', stats.darkCulled);
}
