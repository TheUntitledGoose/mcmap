import fs from 'node:fs';
const c = JSON.parse(fs.readFileSync('build/census.json', 'utf8'));
const a = JSON.parse(fs.readFileSync(process.argv[2] || 'build/assets-test/atlas.json', 'utf8'));
const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const byKey = new Map(a.states.map((x) => [x.k, x]));
let total = 0, covered = 0; const missed = new Map();
for (const st of c.states) {
  total += st.samples;
  const rec = byKey.get(st.key);
  if (rec?.cube || rec?.g?.length) covered += st.samples;
  else if (AIRS.has(st.name)) covered += st.samples;
  else missed.set(st.key, (missed.get(st.key) ?? 0) + st.samples);
}
console.log('covered', (100 * covered / total).toFixed(2) + '%', 'states', c.states.length, 'atlas', a.states.length, 'missedKinds', missed.size);
const top = [...missed].sort((x, y) => y[1] - x[1]).slice(0, 10);
for (const [k, n] of top) console.log('  ', k, 'x' + n, 'rec:', byKey.has(k) ? ('r=' + byKey.get(k).r + ' cube=' + byKey.get(k).cube + ' g=' + (byKey.get(k).g?.length ?? 0)) : 'ABSENT');
