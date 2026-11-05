import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, ab(fs.readFileSync('build/assets/geometry.bin')));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null,
  { isCubeState: (id) => cls.cube[id - 1] === 1 });
const stateId = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state.find((v) => v && cls.cube[v - 1] === 1);
const mk = (cx) => ({ cx, cz: 0, height: new Uint16Array(256).fill(HEIGHT_BIAS + 100), state: new Uint16Array(256).fill(stateId) });
const get = (cx, cz) => (cz === 0 && cx === 0 ? mk(0) : null);
const one = meshShellPatch(assets, get, 0, 0, 1, 1, { maxSkirt: 4 }).stream;
const nrm = new Map();
for (let q = 0; q < one.count; q += 6) {
  const p = [0, 1, 2].map((k) => [one.position[(q + k) * 3], one.position[(q + k) * 3 + 1], one.position[(q + k) * 3 + 2]]);
  const u = p[1].map((v, i) => v - p[0][i]), w = p[2].map((v, i) => v - p[0][i]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const k = n.map((v) => Math.round(v)).join(',');
  nrm.set(k, (nrm.get(k) ?? 0) + 1);
}
console.log('stateId', stateId, 'verts', one.count, [...nrm.entries()].sort());
