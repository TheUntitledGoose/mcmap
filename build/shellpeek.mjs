import { openShellBatch } from '../web/js/payload.js';
const [cx0, cz0, w, h] = process.argv.slice(2).map(Number);
const r = await fetch(`http://127.0.0.1:8765/shells?dim=minecraft:overworld&cx0=${cx0}&cz0=${cz0}&w=${w}&h=${h}`);
const ab = await r.arrayBuffer();
const frames = openShellBatch(ab);
const names = new Map();
for (const f of frames) {
  if (!f) { console.log('hole'); continue; }
  let bi = 0, bh = -9999;
  for (let i = 0; i < 256; i++) { const v = f.height[i] - 2048; if (v > bh) { bh = v; bi = i; } }
  const x = bi & 15, z = bi >> 4;
  console.log(`chunk ${f.cx},${f.cz} maxH=${bh} at(${x},${z}) state=${f.stateAt(x, z)}  minH=${Math.min(...Array.from(f.height, (v) => v - 2048))}`);
}
