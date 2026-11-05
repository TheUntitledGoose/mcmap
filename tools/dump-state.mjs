// Dump the baked quads of one state (or a few) straight out of atlas.json + geometry.bin, in the
// same form the browser mesher sees. Used to answer "is the sprite upside down, or the geometry?"
//   node tools/dump-state.mjs --key "minecraft:grass_block|snowy=false" [--arm 0]
import fs from 'node:fs';
import { GEO_MAGIC } from '../shared/chunk-format.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const atlas = JSON.parse(fs.readFileSync(arg('assets', 'build/assets') + '/atlas.json', 'utf8'));
const bin = fs.readFileSync(arg('geom', 'build/assets/geometry.bin'));
if (bin.subarray(0, 8).toString('ascii') !== GEO_MAGIC) throw new Error('bad geometry magic');
const geoms = bin.readUInt32LE(8), quads = bin.readUInt32LE(12), posScale = bin.readUInt32LE(16);
const POS = 32, UV = POS + geoms * 24, REF = UV + geoms * 16;
const texOf = new Map(atlas.textures.map((t, i) => [i, t]));

function quad(qi) {
  const gi = bin.readUInt32LE(REF + qi * 8);
  const pk = bin.readUInt32LE(REF + qi * 8 + 4);
  const p = [];
  for (let i = 0; i < 4; i++) {
    p.push([
      bin.readInt16LE(POS + gi * 24 + i * 6) / posScale,
      bin.readInt16LE(POS + gi * 24 + i * 6 + 2) / posScale,
      bin.readInt16LE(POS + gi * 24 + i * 6 + 4) / posScale,
    ]);
  }
  const u = [];
  for (let i = 0; i < 4; i++) {
    u.push([bin.readUInt16LE(UV + gi * 16 + i * 4) / 65535, bin.readUInt16LE(UV + gi * 16 + i * 4 + 2) / 65535]);
  }
  return {
    tex: texOf.get(pk & 0xfff)?.id ?? `#${pk & 0xfff}`,
    dir: ((pk >> 12) & 7) - 1, cull: ((pk >> 15) & 7) - 1,
    shade: (pk >> 18) & 1, tintBit: (pk >> 19) & 1,
    pos: p.map((c) => c.map((v) => +v.toFixed(4))),
    uv: u.map((c) => c.map((v) => +v.toFixed(3))),
  };
}

const keys = (arg('keys', '') || '').split(';;').filter(Boolean);
const list = keys.length
  ? keys.map((k) => [k, atlas.states.find((s) => s.k === k)])
  : atlas.states.slice(0, +arg('n', 3)).map((s) => [s.k, s]);

for (const [k, st] of list) {
  if (!st) { console.log(`${k}: not found`); continue; }
  console.log(`\n== ${k}  r=${st.r} l=${st.l} ti=${st.ti} arms=${st.g?.length ?? st.cube?.length ?? 0} w=${st.w ?? '-'}`);
  if (st.cube) {
    const arm = st.cube[+arg('arm', 0)];
    console.log('  cube faces:', arm.map((c) => `${texOf.get(c >> 3)?.id}#t${c & 7}`).join('  '));
    continue;
  }
  const arm = st.g?.[+arg('arm', 0)] ?? [];
  arm.forEach((qi, i) => {
    const q = quad(qi);
    console.log(` [${i}] ${q.tex}  dir=${q.dir} cull=${q.cull} shade=${q.shade} tintBit=${q.tintBit}`);
    console.log(`      pos ${q.pos.map((c) => `[${c.join(',')}]`).join(' ')}`);
    console.log(`      uv  ${q.uv.map((c) => `[${c.join(',')}]`).join(' ')}`);
  });
}
