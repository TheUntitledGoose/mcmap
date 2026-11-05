// Print one vertical column of block states from the chunk payload, the way the renderer sees it.
// Useful when the picture shows terracing or holes and the question is "is that the world, or is
// that my data?". Reads from a running worldd so it exercises the same bytes the browser fetches.
//
// node tools/column.mjs --cx 0 --cz -1 --x 0 --z 0 --y1 126 --y0 100
import { readFileSync } from 'node:fs';
import { openChunk } from '../server/chunk-payload.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const base = arg('base', 'http://127.0.0.1:8765');
const dim = arg('dim', 'overworld');
const cx = +arg('cx', 0), cz = +arg('cz', 0);
const lx = +arg('x', 0), lz = +arg('z', 0);
const y1 = +arg('y1', 126), y0 = +arg('y0', 100);

const r = await fetch(`${base}/voxel?dim=${encodeURIComponent(dim)}&cx=${cx}&cz=${cz}`);
if (!r.ok) {
  console.error(`http ${r.status} for chunk ${cx},${cz}`);
  process.exit(1);
}
const c = openChunk(Buffer.from(await r.arrayBuffer()));
console.log(`chunk ${c.cx},${c.cz}  y ${c.yMin}..${c.yMin + c.yCount * 16 - 1}  surface(${lx},${lz}) = ${c.surfaceAt(lx, lz)}`);

// The payload palette stores 1-based global state ids (0 = unknown); the atlas state table is the
// same numbering, so a column is only readable once the ids are turned back into keys.
const atlas = JSON.parse(readFileSync(arg('assets', 'build/assets/atlas.json'), 'utf8'));
const keyOf = (id) => (id ? atlas.states[id - 1]?.k ?? `id:${id}` : 'unknown');

const runs = [];
let cur = null;
for (let y = y1; y >= y0; y--) {
  const k = keyOf(c.stateAt(lx, y, lz));
  if (cur && cur.k === k) cur.n++;
  else { cur = { k, n: 1, hi: y }; runs.push(cur); }
}
for (const run of runs) console.log(`  y ${String(run.hi).padStart(4)} .. ${String(run.hi - run.n + 1).padStart(4)}  x${String(run.n).padStart(3)}  ${run.k}`);
