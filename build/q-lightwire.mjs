// does the live server ship the light, and does the browser reader see it?
import { openChunk } from '../web/js/payload.js';
import { lightLevels, combineLight } from '../shared/light.mjs';
import { LIGHT_VARIES, LIGHT_UNKNOWN } from '../shared/chunk-format.mjs';
const B = 'http://127.0.0.1:8765';
const code = (c) => c === LIGHT_VARIES ? 'varies' : c === LIGHT_UNKNOWN ? 'UNKNOWN' : String(c);
for (const [cx, cz] of [[0, 0], [3, 5], [186, 125], [100, -100]]) {
  const r = await fetch(`${B}/voxel?dim=minecraft:overworld&cx=${cx}&cz=${cz}`);
  if (!r.ok) { console.log(cx, cz, 'http', r.status); continue; }
  const buf = await r.arrayBuffer();
  const c = openChunk(buf, 0, buf.byteLength);
  const rows = c.sections.map((s) => {
    const lv = lightLevels(c.sectionAt, 8, s.y * 16 + 8, 8);
    return `  Y${String(s.y).padStart(3)} sky=${code(s.sky).padStart(6)} blk=${code(s.blk).padStart(6)} mid=${lv ? `${lv[0]}/${lv[1]}` : '-'}`;
  });
  // sample the spread of combined light over the chunk's loaded sections
  let lo = 99, hi = -1, unknown = 0, n = 0;
  for (const s of c.sections) {
    for (let i = 0; i < 4096; i += 37) {
      const lv = lightLevels(c.sectionAt, i & 15, s.y * 16 + (i >> 8), (i >> 4) & 15);
      if (!lv) continue;
      if (s.sky === LIGHT_UNKNOWN || s.blk === LIGHT_UNKNOWN) unknown++;
      const v = combineLight(lv[0], lv[1], 1);
      lo = Math.min(lo, v); hi = Math.max(hi, v); n++;
    }
  }
  console.log(`chunk ${cx},${cz}  ${(buf.byteLength / 1024).toFixed(1)} KB  sections ${c.sections.length}  light ${lo}..${hi} over ${n} samples, ${unknown} unknown`);
  console.log(rows.slice(0, 6).join('\n'), rows.length > 6 ? `\n  ... ${rows.length - 6} more` : '');
}
