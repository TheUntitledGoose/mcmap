import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellBatch } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(atlas, (() => { const b = fs.readFileSync('build/assets/geometry.bin'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })());
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, null, { isCubeState: (id) => classifyStates(atlas.states, atlas.textures).cube[id - 1] === 1 });
const raw = svc.shellBatchBytes('minecraft:overworld', 0, 0, 4, 4);
const frames = openShellBatch(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)).filter(Boolean);
const by = new Map(frames.map((f) => [`${f.cx},${f.cz}`, f]));
const st = meshShellPatch(assets, (cx, cz) => by.get(`${cx},${cz}`) ?? null, 0, 0, 4, 4, { cell: 1, maxSkirt: 0 }).stream;
const tally = new Map();
for (let q = 0; q < st.count; q += 6) {
  const p = [0, 1, 2].map((k) => [st.position[(q + k) * 3], st.position[(q + k) * 3 + 1], st.position[(q + k) * 3 + 2]]);
  const u = p[1].map((v, i) => v - p[0][i]), w = p[2].map((v, i) => v - p[0][i]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const ax = [0, 1, 2].reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0);
  const key = [0, 0, 0]; key[ax] = Math.sign(n[ax]);
  const k = key.join(',');
  const e = tally.get(k) ?? { n: 0, bad: 0, ex: null };
  e.n++;
  // a face is wrong when the ground is on the side its normal points at: cheap proxy is that a down
  // face must sit above open sky and an up face below solid, so report the block under/over the centre
  if (!e.ex) e.ex = p.map((c) => c.join(',')).join(' -> ');
  tally.set(k, e);
}
for (const [k, v] of tally) console.log(k, v.n, v.ex);
