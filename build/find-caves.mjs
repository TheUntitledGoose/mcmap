// Find underground caverns from the payload cache, so "why are there floaters down there" gets a
// real coordinate instead of a guess. Reads the same cached bytes the browser fetches and scores
// each chunk on enclosed air below the surface.
//
// node build/find-caves.mjs [--n 400] [--near 0,0] [--maxy 60]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { openChunk } from '../web/js/payload.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const N = +arg('n', 400), MAXY = +arg('maxy', 60);
const [NX, NZ] = arg('near', '0,0').split(',').map(Number);
const dir = arg('dir', 'build/cache');
const CZIP = Buffer.from('DVZ1');
// A payload palette holds 1-based global state ids and air is *not* 0 there (0 means outside the
// chunk), so the state table decides what counts as hollow.
const atlas = JSON.parse(readFileSync(arg('atlas', 'build/assets/atlas.json'), 'utf8'));
const keys = (atlas.states || []).map((x) => x.k ?? x.key ?? '');
const HOLLOW = new Set();
keys.forEach((k, i) => { if (/:(air|cave_air|void_air)$/.test(k)) HOLLOW.add(i + 1); });
const LAVA = new Set();
keys.forEach((k, i) => { if (/:lava/.test(k)) LAVA.add(i + 1); });

const roots = [];
for (const tag of readdirSync(dir)) {
  const lit = join(dir, tag, 'lit');
  try { if (statSync(lit).isDirectory()) roots.push(lit); } catch {}
}
const files = [];
for (const r of roots) for (const dim of readdirSync(r)) {
  if (dim !== 'region') continue;   // the overworld's dimKey is 'region'
  const d = join(r, dim);
  for (const f of readdirSync(d)) if (f.endsWith('.bin')) files.push([d, f]);
}
files.sort((a, b) => {
  const [ax, az] = a[1].slice(0, -4).split('_').map(Number), [bx, bz] = b[1].slice(0, -4).split('_').map(Number);
  return ((ax - NX) ** 2 + (az - NZ) ** 2) - ((bx - NX) ** 2 + (bz - NZ) ** 2);
});

const out = [];
for (const [d, f] of files.slice(0, N)) {
  let buf = readFileSync(join(d, f));
  if (buf.subarray(0, 4).equals(CZIP)) { try { buf = inflateSync(buf.subarray(4)); } catch { continue; } }
  let p;
  try { p = openChunk(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); } catch { continue; }
  const [cx, cz] = f.slice(0, -4).split('_').map(Number);
  const top = p.height && p.height.length ? Math.max(...p.height) - 2048 : -999;
  if (top < MAXY + 4) continue;                 // want a real surface overhead
  let enclosed = 0, lowAir = 0, litAir = 0, lava = 0, floor = 999;
  for (let y = (p.yMin | 0) * (p.yMin < -16 ? 1 : 1); y <= MAXY; y++) {
    for (let lz = 0; lz < 16; lz += 2) for (let lx = 0; lx < 16; lx += 2) {
      const id = p.stateAt(cx * 16 + lx, y, cz * 16 + lz);
      if (id && !HOLLOW.has(id)) { if (y < floor) floor = y; if (LAVA.has(id)) lava++; continue; }
      lowAir++;
      // enclosed = solid somewhere above and below within a short reach (a cave, not a void column)
      let up = false, down = false;
      for (let k = 1; k <= 12 && !up; k++) if (p.stateAt(cx * 16 + lx, y + k, cz * 16 + lz)) up = true;
      for (let k = 1; k <= 12 && !down; k++) if (p.stateAt(cx * 16 + lx, y - k, cz * 16 + lz)) down = true;
      if (up && down) { enclosed++; if (p.lightAt(cx * 16 + lx, y, cz * 16 + lz)[1] > 4) litAir++; }
    }
  }
  if (out.length < 4) console.log(`dbg ${cx},${cz} top ${top} lowAir ${lowAir} enclosed ${enclosed} lit ${litAir} lava ${lava} floor ${floor}`);
  if (enclosed > +arg('min', '40')) out.push({ cx, cz, top, enclosed, litAir, lava, lowAir, floor: floor === 999 ? null : floor });
}
out.sort((a, b) => (b.litAir * 4 + b.enclosed) - (a.litAir * 4 + a.enclosed));
for (const h of out.slice(0, 12)) {
  console.log(`chunk ${h.cx},${h.cz}  surface ${h.top}  enclosed ${h.enclosed}/${h.lowAir}` +
    `  lit ${h.litAir}  lava ${h.lava}  floor ${h.floor}` +
    `   -> goto ${h.cx * 16 + 8},${Math.max(-40, Math.min(MAXY - 6, (h.floor ?? 0) + 8))},${h.cz * 16 + 8}`);
}
console.log(`scanned ${Math.min(files.length, N)} chunks, ${out.length} with enclosed air under y${MAXY}`);
