import fs from 'node:fs';
import { Assets } from '../web/js/assets.js';
import { openChunk } from '../web/js/payload.js';
import { meshChunk } from '../web/js/mesher.js';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { WorldService } from '../server/world-service.mjs';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const json = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const assets = new Assets(json, ab(fs.readFileSync('build/assets/geometry.bin')));
const svc = new WorldService('DarkRPG/world', buildStateIds(json.states.map((s) => s.k)), null);
const map = new Map();
for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
  const b = svc.chunkBytes('minecraft:overworld', 3 + dx, 3 + dz);
  if (b) map.set(`${3 + dx},${3 + dz}`, openChunk(ab(b)));
}
const at = (ccx, ccz, lx, ly, lz) => {
  const c = map.get(`${ccx + (lx >> 4)},${ccz + (lz >> 4)}`);
  const s = c && c.sectionAt(ly);
  if (!s) return -1;
  const x = lx & 15, z = lz & 15;
  const id = c.palette[s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((z & 15) << 4) | x]];
  return id === 0 ? -1 : id - 1;
};
const ch = map.get('3,3');
const soup = meshChunk(assets, ch, at, { ao: true }).streams[0];
const ix = meshChunk(assets, ch, at, { ao: true, index: 1 }).streams[0];
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const corner = (s, i) => [r4(s.position[i*3]), r4(s.position[i*3+1]), r4(s.position[i*3+2]),
  r4(s.uv[i*2]), r4(s.uv[i*2+1]), s.color[i*4], s.color[i*4+1], s.color[i*4+2]];
const key = (t) => t.map((c) => c.join(',')).join('#');
const triList = (s) => {
  const out = [];
  const n = s.index ? s.index.length : s.count;
  for (let i = 0; i < n; i += 3) out.push(key([corner(s, s.index ? s.index[i] : i), corner(s, s.index ? s.index[i+1] : i+1), corner(s, s.index ? s.index[i+2] : i+2)]));
  return out;
};
const A = triList(soup), B = triList(ix);
console.log('soup tris', A.length, 'index tris', B.length, 'soup verts', soup.count, 'index verts', ix.count);
const ca = new Map(), cb = new Map();
for (const t of A) ca.set(t, (ca.get(t) || 0) + 1);
for (const t of B) cb.set(t, (cb.get(t) || 0) + 1);
let onlyA = 0, onlyB = 0, first = null;
for (const [k, n] of ca) { const m = cb.get(k) || 0; if (n > m) { onlyA += n - m; if (!first) first = k; } }
for (const [k, n] of cb) { const m = ca.get(k) || 0; if (n > m) onlyB += n - m; }
console.log('only in soup', onlyA, 'only in indexed', onlyB);
if (first) {
  console.log('first soup-only tri:\n ', first.replace(/#/g, '\n  '));
  // find nearest indexed tri by first corner
  const want = first.split('#')[0];
  const near = B.filter((t) => t.startsWith(want))[0];
  console.log('indexed tri with same first corner:\n ', (near || '(none)').replace(/#/g, '\n  '));
}
console.log('--- write order, first 5 corners each ---');
const show = (s, n) => { for (let i = 0; i < n; i++) console.log(' ', i, corner(s, i).join(',')); };
show(soup, 5); console.log('  ...'); show(ix, 5);
console.log('--- index array head ---', Array.from(ix.index.slice(0, 12)).join(','));
console.log('soup head pos', Array.from(soup.position.slice(0, 9)).join(','));
console.log('ix   head pos', Array.from(ix.position.slice(0, 9)).join(','));
