// dbg-facecolour — mesh the shell the way the page does and report, per block state and per face,
// the colour the mesher actually wrote into the vertex attribute. Compared against the framebuffer
// means from tools/probe-grid.js, this says whether a far pixel disagrees with the *mesh* or only
// with the probe's idea of what the mesh should look like.
import { readFileSync } from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const gb = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.length));
const cls = classifyStates(a.states, a.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(a.states.map((s) => s.k)), 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});

const PATCH = 8, SKIRT = 24, DETAIL = 1, BLEND = process.argv.includes('--blend0') ? 0 : 1;
const TIERS = [{ cell: 1, r: 5 }, { cell: 2, r: 16 }, { cell: 4, r: Infinity }];
const key = (cx, cz) => `${cx},${cz}`;
const shells = new Map();
for (let cz = -40; cz <= 40; cz++) {
  for (let cx = -40; cx <= 40; cx++) {
    const raw = svc.shellBytes('minecraft:overworld', cx, cz);
    if (raw) shells.set(key(cx, cz), openShellFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)));
  }
}
const shellAt = (cx, cz) => shells.get(key(cx, cz)) ?? null;
const cellForChunk = (cx, cz) => {
  const d = Math.max(Math.abs(cx), Math.abs(cz));
  let t = 0;
  while (t < TIERS.length - 1 && d > TIERS[t].r) t++;
  return TIERS[t].cell;
};

const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const N2F = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const FACE = ['down', 'up', 'north', 'south', 'west', 'east'];

// tally[stateKey][face] = { n, r, g, b } of framebuffer-equivalent bytes
const tally = new Map();
let quads = 0;
for (let pz = -5; pz <= 5; pz++) {
  for (let px = -5; px <= 5; px++) {
    const { stream } = meshShellPatch(assets, shellAt, px * PATCH, pz * PATCH, PATCH, PATCH, {
      cell: cellForChunk(px * PATCH, pz * PATCH), cellFor: cellForChunk, maxSkirt: SKIRT,
      skip: (cx, cz) => Math.max(Math.abs(cx), Math.abs(cz)) <= DETAIL, blend: BLEND,
      trackStates: true,
    });
    const P = stream.position, C = stream.color, S = stream.stateIds;
    for (let q = 0; q < stream.count; q += 6) {
      quads++;
      // face from the quad's first triangle
      const o = q * 3;
      const ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
      const bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
      if (!m) continue;
      nx /= m; ny /= m; nz /= m;
      let f = -1;
      for (let i = 0; i < 6; i++) {
        if (Math.abs(N2F[i][0] - nx) < 0.5 && Math.abs(N2F[i][1] - ny) < 0.5 && Math.abs(N2F[i][2] - nz) < 0.5) { f = i; break; }
      }
      if (f < 0) continue;
      const st = assets.states[S[q / 6] - 1];
      if (!st) continue;
      let e = tally.get(st.k);
      if (!e) tally.set(st.k, (e = { n: 0, faces: Array.from({ length: 6 }, () => ({ n: 0, c: [0, 0, 0] })) }));
      const t = e.faces[f];
      t.n++;
      // the attribute stores linear light; the framebuffer is sRGB
      for (let k = 0; k < 3; k++) t.c[k] += Math.round(toSrgb(C[q * 4 + k] / 255) * 255);
      e.n++;
    }
  }
}

const want = process.argv.slice(2).filter((s) => !s.startsWith('--'));
const rows = [...tally].map(([k, e]) => {
  let n = 0; const c = [0, 0, 0]; const faces = [];
  for (let f = 0; f < 6; f++) {
    const t = e.faces[f];
    faces.push(t.n);
    n += t.n;
    for (let k2 = 0; k2 < 3; k2++) c[k2] += t.c[k2];
  }
  return { k, n, faces, mean: c.map((v) => Math.round(v / Math.max(1, n))) };
}).filter((r) => r.n > 0);
const pick = want.length ? rows.filter((r) => want.some((w) => r.k.includes(w))) : rows.sort((x, y) => y.n - x.n);
console.log(`quads ${quads} blend ${BLEND} states ${rows.length}`);
for (const r of pick.slice(0, 12)) {
  console.log(`${r.k} quads ${r.n} mean ${JSON.stringify(r.mean)} faces ${JSON.stringify(r.faces)}`);
}
