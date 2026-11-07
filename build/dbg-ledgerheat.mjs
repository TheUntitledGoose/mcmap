import { buildPack } from '../server/ledger-pack.mjs';
import { readPack } from '../shared/ledger-pack.mjs';
import { collectCells, buildHeatQuads } from '../web/js/ledger-view.mjs';
const T = (s) => 1717174690000 + s * 1000;
const spec = [];
for (let i = 0; i < 16384; i++) spec.push([i, 0, 2, 1]);
const R = spec.map(([cx, cz, actionId, playerId], k) => ({ worldId: 1, x: cx * 16 + 3, y: 64, z: cz * 16 + 3, actionId, playerId, timeMs: T(k + 1) }));
const L = { count: R.length, worldId: (i) => R[i].worldId, x: (i) => R[i].x, z: (i) => R[i].z,
  actionId: (i) => R[i].actionId, playerId: (i) => R[i].playerId, timeMs: (i) => R[i].timeMs };
const built = buildPack(L, 1, 'region', { heightOf: (cx, cz) => 70 + ((cx + cz) & 7) });
console.log('cellCount', built.cellCount, 'rows', built.rowCount);
const P = readPack(built.buf);
console.log('pack cells', P.cellCount, 'cell0', P.cell(0));
const got = collectCells(P);
console.log('cells', got.cells.length, 'max', got.max, 'noHeight', got.noHeight);
const g = buildHeatQuads(got.cells);
console.log('quads', g.quads, 'verts', g.verts, 'skipped', g.skipped, 'idxCtor', g.idx.constructor.name, 'last', g.idx[g.idx.length - 1]);
