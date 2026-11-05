import fs from 'node:fs';
const p = 'tests/web-mesh.test.mjs';
let s = fs.readFileSync(p, 'utf8');
const oldAt = `  const at = () => -1;                                   // unknown neighbours: every face shows
  const a = meshChunk(assets, chunk, at, { ao: true });
  const b = meshChunk(assets, longhand, at, { ao: true });`;
const newAt = `  // Neighbour lookups have to resolve inside the chunk itself, or the comparison measures nothing:
  // a stone block beside a stone block is culled either way, and that is exactly the decision the
  // uniform-section shortcut replaces.
  const inside = (ch) => (cx, cz, lx, ly, lz) => {
    if (cx !== ch.cx || cz !== ch.cz) return -1;                  // unknown outside: show the face
    const sec = ch.sectionAt(ly);
    if (!sec) return -1;
    const slot = sec.single ? sec.single - 1 : sec.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)];
    const id = ch.palette[slot];
    return id === 0 ? -1 : id - 1;
  };
  const a = meshChunk(assets, chunk, inside(chunk), { ao: true });
  const b = meshChunk(assets, longhand, inside(longhand), { ao: true });`;
if (!s.includes(oldAt)) throw new Error('anchor not found');
fs.writeFileSync(p, s.replace(oldAt, newAt));
