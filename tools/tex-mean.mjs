// Mean colour of a texture straight out of a jar: tells us whether a sprite is a grey mask that
// needs a biome tint, or already carries its colour.
import { ZipFile } from '../server/zip.mjs';
import { decodePng } from '../server/png.mjs';

const jar = new ZipFile(process.argv[2]);
for (const id of process.argv.slice(3)) {
  const [ns, rest] = id.split(':');
  const name = `assets/${ns}/textures/${rest}.png`;
  const bytes = jar.read(name);
  if (!bytes) { console.log(`${id} not in jar`); continue; }
  const img = decodePng(bytes);
  const frames = img.frames ?? 1;
  const per = img.rgba.length / frames;
  let r = 0, g = 0, b = 0, n = 0, grey = 0;
  for (let i = 0; i < per; i += 4) {
    if (img.rgba[i + 3] < 16) continue;
    r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; n++;
    if (img.rgba[i] === img.rgba[i + 1] && img.rgba[i + 1] === img.rgba[i + 2]) grey++;
  }
  console.log(`${id} ${img.w}x${img.h} frames=${frames} mean=[${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}] grey=${Math.round((100 * grey) / n)}%`);
}
jar.close();
