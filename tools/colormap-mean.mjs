// Mean of the vanilla biome colormaps: the colour a tinted mask should average to over all biomes.
import { ZipFile } from '../server/zip.mjs';
import { decodePng } from '../server/png.mjs';
import { vanillaJar } from '../server/mc-paths.mjs';
const JAR = vanillaJar();
const jar = new ZipFile(JAR);
for (const n of process.argv.slice(2)) {
  const bytes = jar.read(n);
  if (!bytes) { console.log(n, 'missing'); continue; }
  const img = decodePng(bytes);
  let r = 0, g = 0, b = 0, c = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] < 16) continue;
    r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; c++;
  }
  console.log(`${n} ${img.w}x${img.h} mean sRGB [${Math.round(r / c)},${Math.round(g / c)},${Math.round(b / c)}] mult ${(r / c / 255).toFixed(3)},${(g / c / 255).toFixed(3)},${(b / c / 255).toFixed(3)}`);
}
jar.close();
