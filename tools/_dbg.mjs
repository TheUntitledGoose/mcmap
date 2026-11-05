import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openShellFrame } from '../web/js/payload.js';
import { meshShell } from '../web/js/shell-mesh.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { Assets } from '../web/js/assets.js';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, { isCubeState: (id) => cls.cube[id - 1] === 1 });
const get = (cx, cz) => { const b = svc.shellBytes('minecraft:overworld', cx, cz); return b ? openShellFrame(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null; };
const sh = get(3, 3);
console.log('shell', sh && sh.cx, sh && sh.cz, 'height range', Math.min(...sh.height), Math.max(...sh.height));
const r = meshShell(assets, sh, { nb: (cx, cz, x, z) => get(cx + (x >> 4), cz + (z >> 4)) });
console.log('stats', r.stats, 'count', r.stream.count);
for (let i = 0; i < r.stream.count * 3; i += 3) {
  if (![0, 1, 2].every((k) => Number.isFinite(r.stream.position[i + k]))) {
    console.log('non-finite at vert', i / 3, Array.from(r.stream.position.slice(i, i + 3)));
    console.log('neighbours', Array.from(r.stream.position.slice(Math.max(0, i - 9), i + 6)));
    break;
  }
}
