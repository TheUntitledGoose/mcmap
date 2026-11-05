import { readFileSync } from 'node:fs';
const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const rep = JSON.parse(readFileSync('build/assets/report.json', 'utf8'));
const miss = a.textures.filter((t) => t.kind === 3);
console.log('atlas textures', a.textures.length, 'missing/placeholder', miss.length);
console.log(miss.slice(0, 30).map((t) => t.id).join('\n'));
console.log('--- report keys', Object.keys(rep).join(','));
const use = new Map();
for (const st of a.states) {
  const texes = new Set();
  if (st.cube) for (const arm of st.cube) for (const code of arm) texes.add((code >> 3) & 0xfff);
  else if (st.g) for (const arm of st.g) for (const gi of arm) texes.add(a.ref[gi * 2 + 1] & 0xfff ? 0 : (a.ref[gi * 2] & 0xfff));
  const ids = [...texes].filter((i) => a.textures[i]?.kind === 3);
  if (ids.length) use.set(st.k, ids.map((i) => a.textures[i].id));
}
console.log('states touching a placeholder texture:', use.size);
for (const [k, v] of [...use].slice(0, 12)) console.log(' ', k, '->', [...new Set(v)].join(', '));
