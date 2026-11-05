// scratch: why does a shell top face get the colour it gets?
import { readFileSync } from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { openShellFrame } from '../web/js/payload.js';
import { Assets, decodeFaceCode } from '../web/js/assets.js';
import { meshShell } from '../web/js/shell-mesh.js';
import { classifyStates } from '../shared/cube-path.mjs';
import { quadNormal, DIR_INDEX } from '../shared/faces.mjs';
import { tintOf, FACE_SHADE } from '../web/js/mesher.js';
import { FACES } from '../web/js/shell-mesh.js';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const geo = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(a.states, a.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(a.states.map((s) => s.k)), null, {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const get = (cx, cz) => { const b = svc.shellBytes('minecraft:overworld', cx, cz); return b ? openShellFrame(ab(b)) : null; };

console.log('DIR_INDEX', DIR_INDEX);
console.log('shell FACES dirs', JSON.stringify(FACES));
const shell = get(3, 3);
const { stream: s, stats } = meshShell(assets, shell, { nb: get, cell: 1 });
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const hist=new Map();for(let i=0;i<s.count;i++){const k=[s.color[i*4],s.color[i*4+1],s.color[i*4+2]].join(',');hist.set(k,(hist.get(k)||0)+1);}console.log('colour histogram top5',[...hist].sort((a,b)=>b[1]-a[1]).slice(0,12)); console.log('distinct colours', hist.size);let shown = 0;
for (let q = 0; q < s.count && shown < 8; q += 6) {
  const v = (i) => [s.position[i * 3], s.position[i * 3 + 1], s.position[i * 3 + 2]];
  const n = quadNormal([].concat(v(q), v(q + 1), v(q + 2), v(q + 3)));
  if (!(Math.abs(n[1]) > 0.99 && n[1] > 0)) continue;
  const p0 = v(q), p1 = v(q + 1), p2 = v(q + 2);
  const wx = Math.min(p0[0], p1[0], p2[0]), wz = Math.min(p0[2], p1[2], p2[2]);
  const id = shell.state[(((wz & 15) << 4) | (wx & 15))];
  const st = assets.states[id - 1];
  const codes = st.cube?.[0] ?? null;
  const cell = codes ? assets.texCell(decodeFaceCode(codes[DIR_INDEX.up])[0]) : null;
  const want = cell ? [0, 1, 2].map((k) => Math.round(lin(cell.c[k] / 255) * (st.ti && cell.g ? tintOf(st)[k] : 1) * 255)) : null;
  console.log('col', wx, wz, 'y', p0[1], 'id', id, st?.k, '| up sprite', cell?.id, 'g', cell?.g, 'ti', st?.ti, 'l', st?.l,
    '| want', want.join(','), 'got', [s.color[q * 4], s.color[q * 4 + 1], s.color[q * 4 + 2]].join(','));
  shown++;
}
console.log('stats', stats);
