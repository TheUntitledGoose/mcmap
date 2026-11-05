// one-shot patch: gate the biome tint on the atlas grey-mask flag, in both meshers
import fs from 'node:fs';

function patch(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [name, from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`${file}: pattern '${name}' not found`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
  console.log(`patched ${file}`);
}

patch('web/js/mesher.js', [
  ['cube tint',
    '  const tint = state.ti ? tintOf(state) : WHITE;',
    '  // A tint only belongs on a sprite that really is a grey mask (atlas flag `g`): vanilla ships\n'
    + '  // grass_block_top grey but grass_block_side already brown, and mod sprites are authored in colour.\n'
    + '  const tint = state.ti && cell.g ? tintOf(state) : WHITE;'],
  ['quad tint',
    '  const tint = tintBit || state.ti ? tintOf(state) : WHITE;',
    '  const tint = (tintBit || state.ti) && cell.g ? tintOf(state) : WHITE;'],
  ['tint values',
    '  if (/grass|lily_pad|stem|vine|kelp|seagrass|duckweed|spore|shroomlight_moss|moss/.test(k)) t = [0.36, 0.78, 0.28];\n'
    + '  else if (/leaves|leaf|sapling|cactus|bamboo|sugar_cane|fern|bush|leafy|crop|fruit|podzol/.test(k)) t = [0.33, 0.7, 0.24];',
    '  if (/water/.test(k)) t = [0.3, 0.55, 0.85];\n'
    + '  else if (/grass|lily_pad|stem|vine|kelp|seagrass|duckweed|spore|shroomlight_moss|moss/.test(k)) t = [0.4, 0.78, 0.32];\n'
    + '  else if (/leaves|leaf|sapling|cactus|bamboo|sugar_cane|fern|bush|leafy|crop|fruit|podzol/.test(k)) t = [0.37, 0.64, 0.28];'],
  ['tint doc',
    " * Placeholder biome tint. DarkRPG ships no tint maps in the jars we index, and the world has no\n"
    + " * lighting data, so we approximate vanilla's grass/foliage colours per state name. Real tint\n"
    + ' * tables (and a biome grid) replace this in M6; until then an untinted leaf looks washed out\n'
    + ' * rather than wrong.',
    ' * Placeholder biome tint. Vanilla ships grass/leaves/water sprites as grey masks and multiplies a\n'
    + ' * biome colour into them at draw time; with no biome grid yet this stands in for the average one,\n'
    + ' * close to the colormap means measured out of the vanilla jar. It is applied only where the sprite\n'
    + ' * really is a grey mask (`cell.g`): grass_block_side ships already brown and mod sprites are\n'
    + ' * authored in colour, so tinting on block name alone painted whole hillsides olive.'],
]);

patch('web/js/shell-mesh.js', [
  ['tint import',
    "import { VertexStream, FACE_SHADE, CUBE } from './mesher.js';",
    "import { VertexStream, FACE_SHADE, CUBE, tintOf } from './mesher.js';"],
  ['faceColors body',
    '  const out = FACE_SHADE.map((s, f) => {\n'
    + '    const c = per[f]?.cell.c ?? per[1]?.cell.c ?? GREY;\n'
    + '    const m = Math.max(s * shade, emissive);',
    '  const out = FACE_SHADE.map((s, f) => {\n'
    + '    const cell = per[f]?.cell ?? per[1]?.cell;\n'
    + '    const c = cell?.c ?? GREY;\n'
    + '    // the same grey-mask gate the detail mesher uses: the mean of a mask is grey, it needs the tint\n'
    + '    const tint = state.ti && cell?.g ? tintOf(state) : WHITE;\n'
    + '    const m = Math.max(s * shade, emissive);'],
  ['faceColors multiply',
    '      Math.round(srgbToLinear(c[0] / 255) * m * 255),\n'
    + '      Math.round(srgbToLinear(c[1] / 255) * m * 255),\n'
    + '      Math.round(srgbToLinear(c[2] / 255) * m * 255),',
    '      Math.round(srgbToLinear(c[0] / 255) * tint[0] * m * 255),\n'
    + '      Math.round(srgbToLinear(c[1] / 255) * tint[1] * m * 255),\n'
    + '      Math.round(srgbToLinear(c[2] / 255) * tint[2] * m * 255),'],
  ['white constant',
    'const GREY = [136, 136, 136];',
    'const GREY = [136, 136, 136];\nconst WHITE = [1, 1, 1];'],
]);
