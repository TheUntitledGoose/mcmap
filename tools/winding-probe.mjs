// what normals does the shell mesher actually emit, per face?
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { quadNormal } from '../shared/faces.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, { isCubeState: (id) => cls.cube[id - 1] === 1 });
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const stateId = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state.find((v) => v && cls.cube[v - 1] === 1);
const sh = { cx: 0, cz: 0, height: new Uint16Array(256).fill(HEIGHT_BIAS + 100), state: new Uint16Array(256).fill(stateId) };
const get = (cx, cz) => (cx === 0 && cz === 0 ? sh : null);
const one = meshShellPatch(assets, get, 0, 0, 1, 1, { maxSkirt: 4 });
const m = new Map();
for (let q = 0; q < one.stream.count; q += 6) {
  const flat = one.stream.position.subarray(q * 3, q * 3 + 9);
  const n = quadNormal(flat);
  const k = n.map((v) => v.toFixed(2)).join(',');
  m.set(k, (m.get(k) ?? 0) + 1);
}
console.log('stats', one.stats);
console.log([...m.entries()].sort());
// and the ring order used for each face
import { CANON_RING } from '../shared/cube-path.mjs';
for (let f = 0; f < 6; f++) {
  const pts = CANON_RING[f].map((s) => s.split(',').map(Number));
  const flat = [pts[0], pts[1], pts[2]].flat();
  console.log('ring', f, JSON.stringify(pts), '->', quadNormal(flat).map((v) => v.toFixed(2)).join(','));
}
