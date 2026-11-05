// Does the BAKED quad path wind outward? Compare each stored quad's geometric normal against the
// face direction recorded in its ref. Anything wrong here shows up as culled faces in the browser.
import fs from 'node:fs';
import { FACE_INFO } from '../shared/faces.mjs';
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const bin = fs.readFileSync('build/assets/geometry.bin');
const geoms = bin.readUInt32LE(8), quads = bin.readUInt32LE(12), posScale = bin.readUInt32LE(16);
const POS = 32, UV = POS + geoms * 24, REF = UV + geoms * 16;
const bad = new Map();
let checked = 0, undirected = 0;
for (let qi = 0; qi < quads; qi++) {
  const gi = bin.readUInt32LE(REF + qi * 8);
  const pk = bin.readUInt32LE(REF + qi * 8 + 4);
  const dir = ((pk >> 12) & 7) - 1;
  if (dir < 0) { undirected++; continue; }
  const p = [];
  for (let k = 0; k < 3; k++) {
    const o = POS + gi * 24 + k * 6;
    p.push([bin.readInt16LE(o) / posScale * 16, bin.readInt16LE(o + 2) / posScale * 16, bin.readInt16LE(o + 4) / posScale * 16]);
  }
  const a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const info = FACE_INFO[dir];
  if (n[info.axis] * info.sign > 0) { checked++; continue; }
  checked++;
  const key = atlas.states.length ? dirName(dir) : dir;
  bad.set(key, (bad.get(key) ?? 0) + 1);
}
function dirName(d) { return ['down', 'up', 'north', 'south', 'west', 'east'][d]; }
console.log('quads', quads, 'with a face direction', checked, 'no direction', undirected);
console.log('wound inward:', [...bad.entries()].sort((x, y) => y[1] - x[1]));
