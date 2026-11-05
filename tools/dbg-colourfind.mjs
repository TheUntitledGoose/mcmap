// Which atlas sprite, after the shell mesher's own colour maths, produces a given vertex colour?
// The browser probe reported shell triangles carrying raw colour bytes 78,18,90, so the answer is a
// sprite mean times a face shade (times a tint) - search the whole texture table for the match.
import { readFileSync } from 'node:fs';
import { FACE_SHADE, tintOf } from '../web/js/mesher.js';

const a = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const target = process.argv.slice(2).map(Number);
const want = (got, f) => got.every((v, i) => Math.abs(v - target[i]) <= f);

const hits = [];
for (const [ti, t] of a.textures.entries()) {
  if (!t.c) continue;
  const lin = t.c.map((v) => srgbToLinear(v / 255));
  for (const [fi, s] of FACE_SHADE.entries()) {
    for (const tintName of [null, 'grass', 'leaves', 'water']) {
      const st = { k: tintName ? `minecraft:${tintName}` : t.id };
      const tint = t.g && (st.k !== t.id) ? tintOf(st) : [1, 1, 1];
      const got = [0, 1, 2].map((i) => ((lin[i] * tint[i] * s) * 255) | 0);
      if (want(got, 3)) hits.push({ ti, id: t.id, c: t.c, g: t.g, kind: t.kind, shade: s, tint, got });
    }
  }
}
console.log(`${a.textures.length} textures, matches for [${target}]:`, hits.length);
for (const h of hits.slice(0, 25)) console.log(JSON.stringify(h));

// Also: any sprite whose own mean is already strongly magenta?
const pink = a.textures.filter((t) => t.c && t.c[0] > 110 && t.c[2] > 110 && t.c[0] - t.c[1] > 40 && t.c[2] - t.c[1] > 40);
console.log(`magenta-ish sprites: ${pink.length}`);
for (const t of pink.slice(0, 25)) console.log(`  ${t.id} c=${JSON.stringify(t.c)} g=${t.g} kind=${t.kind}`);
