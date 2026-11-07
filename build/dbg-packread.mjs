// What does one 64x64 far-view block cost the server, filled or sparse, and is the baked shell pack being
// used or silently rejected? A rejected pack turns every far tile into per-chunk payload work, which is
// the difference between a column read and four thousand lookups.
import fs from 'node:fs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const { buildStateIds } = await import('../server/chunk-payload.mjs');
const { WorldService } = await import('../server/world-service.mjs');
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', { packDir: 'build/shells', lodDir: 'build/lods' });
console.log('stamp', svc.stamp, 'packDir', svc.packDir);
console.log('packError', svc.packError ?? '(none yet)');
for (const [rx, rz] of [[0, 0], [-4, 18], [-12, 35], [22, 55]]) {
  const p = svc.packFor('minecraft:overworld', rx, rz);
  console.log(`packFor region ${rx},${rz}:`, p ? `pack (cols? ${!!p.cols})` : 'null', 'packError:', svc.packError ?? '-');
}
const DIM = 'minecraft:overworld';
for (const [label, cx, cz] of [['filled 0,0', 0, 0], ['sparse -128,576', -128, 576], ['off-map -2500,576', -2500, 576]]) {
  const before = { ...svc.stats };
  const t0 = performance.now();
  const b = await svc.shellBatchBytesAsync(DIM, cx, cz, 64, 64);
  const ms = performance.now() - t0;
  const d = Object.fromEntries(Object.entries(svc.stats).filter(([k, v]) => v !== before[k]).map(([k, v]) => [k, v - before[k]]));
  console.log(`/shells 64x64 ${label}`.padEnd(26), `${ms.toFixed(0)} ms, ${(b.length / 1024).toFixed(0)} KB`, JSON.stringify(d));
}
console.log('packError now', svc.packError ?? '(none)');
