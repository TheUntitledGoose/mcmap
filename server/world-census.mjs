// Full-world scan: every chunk in every dimension. Emits build/census.json used by the
// asset packer (which textures/models must resolve) and M8 (modded coverage report).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import { stateKey } from '../shared/state-key.mjs';

const WORLD = process.argv[2] ?? 'DarkRPG/world';
const OUT = process.argv[3] ?? 'build/census.json';

function listDims() {
  const out = [];
  const name = (d) => d === 'region' ? 'minecraft:overworld'
    : d === 'DIM-1' ? 'minecraft:the_nether'
    : d === 'DIM1' ? 'minecraft:the_end' : d;
  if (fs.existsSync(path.join(WORLD, 'region'))) out.push({ id: name('region'), dir: 'region' });
  for (const d of fs.readdirSync(WORLD)) {
    if (d !== 'region' && fs.existsSync(path.join(WORLD, d, 'region'))) {
      out.push({ id: name(d), dir: `${d}/region` });
    }
  }
  // Fabric/data-pack dimensions live under world/dimensions/<namespace>/<path>/region
  const dimRoot = path.join(WORLD, 'dimensions');
  if (fs.existsSync(dimRoot)) {
    for (const ns of fs.readdirSync(dimRoot)) {
      for (const p of fs.readdirSync(path.join(dimRoot, ns))) {
        const rel = `dimensions/${ns}/${p}/region`;
        if (fs.existsSync(path.join(WORLD, rel))) out.push({ id: `${ns}:${p}`, dir: rel });
      }
    }
  }
  return out;
}

const states = new Map(); // "name|p=v,..." -> { key, name, props, sections, samples }
function touch(name, props) {
  const key = stateKey(name, props);
  let e = states.get(key);
  if (!e) { e = { key, name, props: props ?? null, sections: 0, samples: 0 }; states.set(key, e); }
  return e;
}

const dims = [];
const t0 = Date.now();
for (const dim of listDims()) {
  const dir = path.join(WORLD, dim.dir);
  const files = fs.readdirSync(dir).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f));
  const s = {
    id: dim.id, dir: dim.dir, regions: files.length, chunks: 0, bad: 0,
    ys: [Infinity, -Infinity], singleValueSections: 0, paletteSections: 0,
    air: 0, nonAir: 0,
    extent: { minRegionX: Infinity, maxRegionX: -Infinity, minRegionZ: Infinity, maxRegionZ: -Infinity },
    sectionFormats: {},
  };
  for (const f of files) {
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
    s.extent.minRegionX = Math.min(s.extent.minRegionX, +m[1]);
    s.extent.maxRegionX = Math.max(s.extent.maxRegionX, +m[1]);
    s.extent.minRegionZ = Math.min(s.extent.minRegionZ, +m[2]);
    s.extent.maxRegionZ = Math.max(s.extent.maxRegionZ, +m[2]);
    const rgn = new RegionFile(path.join(dir, f));
    for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
      if (!rgn.entry(cx, cz)) continue;
      let c;
      try { c = readNbt(zlib.inflateSync(rgn.readChunkNbtBytes(cx, cz))).value; }
      catch { s.bad++; continue; }
      s.chunks++;
      for (const sec of c.sections ?? []) {
        const y = Number(sec.Y);
        const classic = sec.BlockStatePalette;
        const modern = sec.block_states?.palette;
        const pal = modern ?? classic;
        if (!pal) { s.sectionFormats.empty = (s.sectionFormats.empty ?? 0) + 1; continue; }
        s.sectionFormats[modern ? 'block_states' : 'BlockStatePalette'] =
          (s.sectionFormats[modern ? 'block_states' : 'BlockStatePalette'] ?? 0) + 1;
        s.ys[0] = Math.min(s.ys[0], y); s.ys[1] = Math.max(s.ys[1], y);
        if (pal.length === 1) {
          s.singleValueSections++;
          const e = touch(pal[0].Name, pal[0].Properties);
          e.sections++;
          if (pal[0].Name === 'minecraft:air') s.air += 4096; else s.nonAir += 4096;
          continue;
        }
        s.paletteSections++;
        for (const p of pal) touch(p.Name, p.Properties).samples++;
      }
    }
    rgn.close();
  }
  dims.push(s);
  console.log(`${dim.id.padEnd(22)} chunks=${String(s.chunks).padStart(7)} y=${s.ys[0]}..${s.ys[1]} ` +
              `formats=${JSON.stringify(s.sectionFormats)} bad=${s.bad} ${Date.now() - t0}ms`);
}

const list = [...states.values()].sort((a, b) => b.samples - a.samples);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ world: WORLD, generated: Date.now(), dims, states: list }));
console.log(`\ndistinct block states: ${list.length}`);
console.log('top 15:');
for (const e of list.slice(0, 15)) console.log('  ', String(e.samples).padStart(8), e.key);
console.log('wrote', OUT, `${Date.now() - t0}ms`);
