// Profile what a far pan costs the server when shell packs ARE available (the stamp is what the live
// server has). 64 shell blocks of 64x64, the way dbg-farpan.mjs walks them over HTTP: if this is fast in
// process and slow over HTTP, the cost is scheduling, not chunk work.
import fs from 'node:fs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const { classifyStates } = await import('../shared/cube-path.mjs');
const { WorldService } = await import('../server/world-service.mjs');
const ids = buildStateIds(atlas.states.map((s) => s.k));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {
  isCubeState: (id) => cls.cube[id - 1] === 1,
  isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
  isSolidState: (id) => cls.cube[id - 1] === 1,
  isFilmState: (id) => cls.film ? cls.film[id - 1] === 1 : false,
  packDir: 'build/shells', lodDir: 'build/lods', stamp: atlas.stamp,
});
console.log('stamp', svc.stamp);
const DIM = 'minecraft:overworld';
const rows = [];
async function block(label, cx, cz, every) {
  const before = { ...svc.stats };
  const t0 = performance.now();
  const b = await svc.shellBatchBytesAsync(DIM, cx, cz, 64, 64, every);
  const ms = performance.now() - t0;
  const d = Object.fromEntries(Object.entries(svc.stats).filter(([k, v]) => v !== before[k]).map(([k, v]) => [k, v - before[k]]));
  rows.push({ label, ms: +ms.toFixed(0), kb: +(b.length / 1024).toFixed(0), every, ...d });
}
// The pan in dbg-farpan walked these; run them twice so the second pass shows the warm-shell cost.
const SPOT = [[-640, 896], [-512, 832], [-448, 896], [-384, 832], [0, 0], [-128, 576]];
for (const [cx, cz] of SPOT) await block(`cold ${cx},${cz}`, cx, cz, 48);
for (const [cx, cz] of SPOT) await block(`warm ${cx},${cz}`, cx, cz, 48);
for (const [cx, cz] of SPOT) await block(`noyield ${cx},${cz}`, cx, cz, 0);
console.table(rows);
