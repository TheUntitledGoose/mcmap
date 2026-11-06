// Are the blue rectangles in the middle of populated ground holes in the *save*, or holes in our
// loading? Read the region headers around a spot and report missing chunks that are surrounded by
// present ones: those are chunks the server never generated, and nothing can stream them.
import { RegionFile } from '../tools/region.mjs';
import fs from 'node:fs';
import path from 'node:path';

const REGION_DIR = process.argv[2] ?? 'DarkRPG/world/region';
const [RX0, RZ0, W, H] = [Number(process.argv[3] ?? 3), Number(process.argv[4] ?? 1),
  Number(process.argv[5] ?? 5), Number(process.argv[6] ?? 5)];

let present = 0, missing = 0, blobs = [], borderBlobs = 0;
for (let rz = RZ0; rz < RZ0 + H; rz++) {
  for (let rx = RX0; rx < RX0 + W; rx++) {
    const f = path.join(REGION_DIR, `r.${rx}.${rz}.mca`);
    if (!fs.existsSync(f)) continue;
    const r = new RegionFile(f);
    const has = (x, z) => !!r.entry(x, z);
    const seen = new Uint8Array(32 * 32);
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      if (has(x, z)) { present++; seen[(z << 5) | x] = 1; continue; }
      missing++;
      if (seen[(z << 5) | x]) continue;
      // flood fill the connected run of missing chunks inside this region
      const stack = [[x, z]], cells = [];
      let touchesBorder = false;
      seen[(z << 5) | x] = 1;
      while (stack.length) {
        const [cx, cz] = stack.pop();
        cells.push([rx * 32 + cx, rz * 32 + cz]);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx > 31 || nz > 31) { touchesBorder = true; continue; }
          if (has(nx, nz) || seen[(nz << 5) | nx]) continue;
          seen[(nz << 5) | nx] = 1;
          stack.push([nx, nz]);
        }
      }
      if (touchesBorder) borderBlobs++; else blobs.push({ cells, rx, rz });
    }
    r.close?.();
  }
}
blobs.sort((a, b) => b.cells.length - a.cells.length);
console.log(`present ${present} missing ${missing}`);
console.log(`enclosed gaps (do not touch a region border): ${blobs.length} covering ` +
  blobs.reduce((s, b) => s + b.cells.length, 0) + ` chunks; edge-touching: ${borderBlobs}`);
const hist = {};
for (const b of blobs) hist[Math.min(64, b.cells.length)] = (hist[Math.min(64, b.cells.length)] ?? 0) + 1;
console.log('size histogram (size -> count, >64 clamped):', JSON.stringify(hist));
for (const b of blobs.slice(0, 12)) {
  const xs = b.cells.map((c) => c[0]), zs = b.cells.map((c) => c[1]);
  console.log(`  ${b.cells.length} chunks in x ${Math.min(...xs)}..${Math.max(...xs)} ` +
    `z ${Math.min(...zs)}..${Math.max(...zs)} (chunk ${b.cells[0][0]},${b.cells[0][1]})`);
}
