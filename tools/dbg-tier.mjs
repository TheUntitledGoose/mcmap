import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, { isCubeState: (id) => cls.cube[id - 1] === 1 });
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const stateId = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state.find((v) => v && cls.cube[v - 1] === 1);
const mk = (cx, h) => ({ cx, cz: 0,
  height: Uint16Array.from(Array.from({ length: 256 }, (_, k) => HEIGHT_BIAS + (typeof h === 'function' ? h(k & 15, k >> 4) : h))),
  state: new Uint16Array(256).fill(stateId) });
const stepWalls = (st) => { const out = [];
  for (let q = 0; q < st.count; q += 6) { let yLo = Infinity, yHi = -Infinity;
    for (let v = q; v < q + 6; v++) { const y = st.position[v * 3 + 1]; yLo = Math.min(yLo, y); yHi = Math.max(yHi, y); }
    if (yHi > yLo) { const xs=[]; for (let v=q; v<q+6; v++) xs.push(st.position[v*3]); const zs=[]; for (let v=q; v<q+6; v++) zs.push(st.position[v*3+2]); out.push([st.position[q*3], yLo, yHi, 'xset'+[...new Set(xs)].join('|'), 'zset'+[...new Set(zs)].join('|')]); } } return out; };
const a = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 0 ? ((x) => (x >= 8 ? 104 : 100)) : 100) : null),
  0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 1 : 4) });
const wa = stepWalls(a.stream);
console.log('case a: all walls', wa.length, 'by plane', JSON.stringify([...wa.reduce((m, w) => m.set(w[0] + ':' + (w[2] - w[1]), (m.get(w[0] + ':' + (w[2] - w[1])) || 0) + 1), new Map())]));
const b = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 0 ? 104 : 100) : null),
  0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 4 : 1) });
const wb = stepWalls(b.stream);
console.log('case b: all walls', wb.length, 'by plane', JSON.stringify([...wb.reduce((m, w) => m.set(w[0] + ':' + (w[2] - w[1]), (m.get(w[0] + ':' + (w[2] - w[1])) || 0) + 1), new Map())]), 'cols', b.stats.columns);
console.log('case b wall detail', JSON.stringify(wb.slice(0, 8)));
