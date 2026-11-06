// Are far trees standing on the forest floor, or on their own trunk?
// Read the shell frame the bake will write and ask, per column, how far its `ground` sits above the
// median ground of the four neighbouring columns. A tree on a slope can pass the structural test in
// shell.mjs (two of its trunk's side neighbours are hillside), and then the far cell stands at trunk
// top: the box the user is looking at.
import { openChunk } from '../server/chunk-payload.mjs';
import { shellFromPayload, shellPlanes } from '../server/shell.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { readFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'http://127.0.0.1:8765');
const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const cls = classifyStates(atlas.states, atlas.textures);
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const isSolid = (id) => cls.cube[id - 1] === 1;
const name = (id) => (id > 0 && id <= atlas.states.length ? atlas.states[id - 1].k : '');
const cx0 = +arg('cx', 3), cz0 = +arg('cz', 3), R = +arg('r', 4);

let cols = 0, leaf = 0, tall = 0, slopePass = 0, hist = [];
for (let cz = cz0 - R; cz <= cz0 + R; cz++) for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
  const r = await fetch(`${base}/voxel?dim=overworld&cx=${cx}&cz=${cz}`);
  if (!r.ok) continue;
  const bytes = Buffer.from(await r.arrayBuffer());
  const buf = shellFromPayload(bytes, { isPaint, isSolid, hasSky: true });
  if (!buf) continue;
  const { h, cover: cv, g, state: st } = shellPlanes(buf);
  const at = (x, z) => g[(z << 4) | x];
  for (let z = 1; z < 15; z++) for (let x = 1; x < 15; x++) {
    const i = (z << 4) | x;
    if (!h[i]) continue;
    cols++;
    const nb = [at(x - 1, z), at(x + 1, z), at(x, z - 1), at(x, z + 1)].sort((a, b) => a - b);
    const med = (nb[1] + nb[2]) / 2;
    const over = at(x, z) - med;
    const isLeaves = name(cv[i]).includes('leaves'), isLog = name(st[i]).includes('log') || name(st[i]).includes('wood') || name(st[i]).includes('stem');
    if (isLeaves || isLog) leaf++;
    if (over >= 3) {
      tall++;
      if (h[i] - g[i] >= 2) slopePass++;
      if (hist.length < 8) hist.push(`${cx},${cz} x${x} z${z} h=${h[i] - 2048} g=${g[i] - 2048} med=${med - 2048} cover=${name(cv[i])} paint=${name(st[i])}`);
    }
  }
}
console.log(JSON.stringify({ cols, veg: leaf, ground3plusAboveNeighbourMedian: tall,
  ofWhichTheColumnIsStillTallerThanItsOwnGround: slopePass, pct: +(100 * tall / Math.max(1, leaf)).toFixed(2) }, null, 1));
for (const s of hist) console.log('  ' + s);
