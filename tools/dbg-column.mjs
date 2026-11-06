// One column, three views: the voxels, the shell frame the far layer reads, and what the frame says
// the cell should stand on.
import { openChunk } from '../server/chunk-payload.mjs';
import { shellFromPayload, shellPlanes } from '../server/shell.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { readFileSync } from 'node:fs';
const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const isSolid = (id) => cls.cube[id - 1] === 1;
const isFilm = (id) => cls.film[id - 1] === 1;
const nm = (id) => (id > 0 && id <= atlas.states.length ? atlas.states[id - 1].k : id ? '#' + id : 'air');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const wx = +arg('x'), wz = +arg('z');
const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16), lx = wx - cx * 16, lz = wz - cz * 16;
const r = await fetch(`http://127.0.0.1:8765/voxel?dim=overworld&cx=${cx}&cz=${cz}`);
if (!r.ok) { console.log('no chunk', cx, cz, r.status); process.exit(1); }
const bytes = Buffer.from(await r.arrayBuffer());
const c = openChunk(bytes);
const top = c.surfaceAt(lx, lz);
console.log(`chunk ${cx},${cz} local ${lx},${lz} surface=${top}`);
for (let d = 0; d <= 8; d++) console.log(`  y=${top - d} ${nm(c.stateAt(lx, top - d, lz))} cube=${c.stateAt(lx, top - d, lz) ? cls.cube[c.stateAt(lx, top - d, lz) - 1] : '-'} op=${c.stateAt(lx, top - d, lz) ? cls.opaque[c.stateAt(lx, top - d, lz) - 1] : '-'} film=${c.stateAt(lx, top - d, lz) ? cls.film[c.stateAt(lx, top - d, lz) - 1] : '-'}`);
const buf = shellFromPayload(bytes, { isPaint, isSolid, isFilm, hasSky: true });
const { h, cover, g, state, band } = shellPlanes(buf);
const i = (lz << 4) | lx;
const at = (x, z) => g[(z << 4) | x] - 2048;
console.log(`frame: h=${h[i] - 2048} cover=${nm(cover[i])} ground=${g[i] - 2048} paint=${nm(state[i])} skin=${band[i]}`);
// what the far layer would actually do with this column at a coarse cell: the body it stands on, and
// whether the skin is thick enough to draw as its own plate
for (const bnd of [band[i]]) {
  const ht = h[i] - 2048, gd = g[i] - 2048;
  const cap = bnd >= 4 && ht - bnd + 1 > gd;
  console.log(`far cell: body=${gd === ht ? ht : gd} cap=${cap ? `${ht - bnd + 1}..${ht}` : 'none'}` +
    `${cap ? '' : ` (skin ${bnd} of capDrop 4, skin base ${ht - bnd + 1} vs body ${gd})`}`);
}
console.log(`neighbour ground: ${[at(lx - 1, lz), at(lx + 1, lz), at(lx, lz - 1), at(lx, lz + 1)].join(' ')}`);
