// dbg-pink — mesh shell patches exactly the way the page does (patch 8, LOD tiers, blend, skirt,
// detail skip) and histogram the vertex colours, so the magenta pixels in the browser probe can be
// traced to a state, a face, and a sprite without a GPU in the loop.
import { readFileSync } from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { tintOf } from '../web/js/mesher.js';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const gb = readFileSync('build/assets/geometry.bin');
const assets = new Assets(a, gb.buffer.slice(gb.byteOffset, gb.byteOffset + gb.length));
const cls = classifyStates(a.states, a.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(a.states.map((s) => s.k)), 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});

const PATCH = 8, DETAIL = 1, SKIRT = 24;
const TIERS = [{ cell: 1, r: 5 }, { cell: 2, r: 16 }, { cell: 4, r: Infinity }];
const cellOf = (t) => TIERS[t].cell;
const sh = (cx, cz) => `${cx},${cz}`;
const shells = new Map();
for (let cz = -25; cz <= 25; cz++) {
  for (let cx = -25; cx <= 25; cx++) {
    const raw = svc.shellBytes('minecraft:overworld', cx, cz);
    if (raw) shells.set(sh(cx, cz), openShellFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)));
  }
}
const shellAt = (cx, cz) => shells.get(sh(cx, cz)) ?? null;
const detailHere = (cx, cz) => Math.max(Math.abs(cx), Math.abs(cz)) <= DETAIL;
const cellForChunk = (cx, cz) => {
  const d = Math.max(Math.abs(cx), Math.abs(cz));
  let t = 0;
  while (t < TIERS.length - 1 && d > TIERS[t].r) t++;
  return cellOf(t);
};

// Which chunk cells are worth looking at: the ones the far probe saw from (0,150,0).
const hist = new Map(), byKey = new Map();
let cols = 0, walls = 0, noSprite = 0;
for (let pz = -5; pz <= 5; pz++) {
  for (let px = -5; px <= 5; px++) {
    const { stream, stats } = meshShellPatch(assets, shellAt, px * PATCH, pz * PATCH, PATCH, PATCH, {
      cell: cellForChunk(px * PATCH, pz * PATCH), cellFor: cellForChunk, maxSkirt: SKIRT,
      skip: detailHere, blend: 1,
    });
    cols += stats.columns; walls += stats.walls; noSprite += stats.noSprite ?? 0;
    // Walk quads: for each of its two triangles, the first vertex carries the face colour.
    const pos = stream.position, col = stream.color;
    const cz0 = pz * PATCH, cx0 = px * PATCH;
    for (let q = 0; q < stream.count; q += 6) {
      const r = col[q * 4], g = col[q * 4 + 1], b = col[q * 4 + 2];
      const x = pos[q * 3], z = pos[q * 3 + 2], y = pos[q * 3 + 1];
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
      const s = shellAt(cx, cz);
      const id = s ? s.state[(((z - cz * 16) & 15) << 4) | ((x - cx * 16) & 15)] : 0;
      const st = assets.states[id - 1];
      const key = `${st?.k ?? id}|${Math.abs(x - Math.round(x / 16) * 16) < 0.01 ? 'wall' : 'top'}`;
      const h = hist.get(`${r},${g},${b}`) ?? 0;
      hist.set(`${r},${g},${b}`, h + 1);
      if (r > 100 && b > 100 && r - g > 40 && b - g > 40) {
        const e = byKey.get(key) ?? { n: 0, ex: [], k: st?.k ?? String(id), ti: st?.ti, fc: st?.fc, cube: st?.cube ? 1 : 0 };
        e.n++;
        if (e.ex.length < 3) e.ex.push({ x, y, z, rgb: [r, g, b] });
        byKey.set(key, e);
      }
    }
  }
}
console.log(`columns ${cols} walls ${walls} noSprite ${noSprite}`);
const pinkTop = [...byKey].sort((x, y) => y[1].n - x[1].n).slice(0, 10);
for (const [k, e] of pinkTop) {
  const st = assets.states[assets.indexOf(e.k)];
  console.log(`pink ${e.n} ${e.k} ti=${e.ti} cube=${e.cube} fc=${e.fc} tint=${tintOf(st)} ex=${JSON.stringify(e.ex[0])}`);
}
console.log('top colours:', [...hist].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([c, n]) => `${c}x${n}`).join(' '));
