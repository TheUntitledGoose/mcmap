// Where should a lighting screenshot be taken?  Spread samples across the overworld and report
// places the save's own light field will show something:
//   - columns whose surface cell is not full daylight (canopy, overhang, cave under the surface)
//   - cells a few blocks under the surface that the save lights strongly (torches, lava, a base)
//   - cells with a daylight-to-dark step within two blocks (a mouth daylight is pouring into)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { readNbt } from '../tools/nbt.mjs';
import { RegionFile } from '../tools/region.mjs';
import { nibbleAt } from '../shared/light.mjs';

const REGIONS = +(process.env.REGIONS || 24);       // region files sampled
const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});
const dim = svc.dimList().find((d) => d.id === 'minecraft:overworld');

const unpack = (longs, bits, count) => {
  const out = new Int32Array(count), mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const bit = i * bits, w = longs[bit >> 6], sh = BigInt(bit & 63);
    let v = (w >> sh) & mask;
    if ((bit & 63) + bits > 64) {
      v |= (longs[(bit >> 6) + 1] & ((1n << BigInt((bit & 63) + bits - 64)) - 1n)) << BigInt(64 - (bit & 63));
    }
    out[i] = Number(v);
  }
  return out;
};

const files = [];
for (const f of fs.readdirSync(dim.dir)) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
  if (m) files.push({ rx: +m[1], rz: +m[2], path: `${dim.dir}/${f}` });
}
files.sort((a, b) => (a.rx - b.rx) || (a.rz - b.rz));
const step = Math.max(1, Math.floor(files.length / REGIONS));
const picked = files.filter((_, i) => i % step === 0).slice(0, REGIONS);

const shade = [], torch = [], mouth = [];
const hist = () => new Array(17).fill(0);
const histSky = hist(), histSkyBelow = hist(), histBlk = hist();
for (const { path, rx, rz } of picked) {
  let rf;
  try { rf = new RegionFile(path); } catch { continue; }
  for (let lz = 0; lz < 32; lz += 4) {
    for (let lx = 0; lx < 32; lx += 4) {
      const raw = rf.readChunkNbtBytes(lx, lz);
      if (!raw) continue;
      let nbt;
      try { nbt = readNbt(zlib.inflateSync(raw)).value; } catch { continue; }
      const cx = rx * 32 + lx, cz = rz * 32 + lz;
      // 1.20 chunks store no yMax; the section list says how tall the chunk is
      const ys = (nbt.sections ?? []).map((s) => s.Y);
      if (!ys.length) continue;
      const minY = nbt.yPos * 16, span = (Math.max(...ys) - Math.min(...ys) + 1) * 16;
      const bits = 32 - Math.clz32(span);
      const surf = nbt.Heightmaps?.WORLD_SURFACE && unpack(nbt.Heightmaps.WORLD_SURFACE, bits, 256);
      const secs = new Map((nbt.sections ?? []).map((s) => [s.Y, s]));
      if (!surf) continue;
      for (let pz = 0; pz < 16; pz += 2) {
        for (let px = 0; px < 16; px += 2) {
          const top = minY + surf[(pz << 4) | px] - 1;
          const at = (y) => {
            const s = secs.get(y >> 4);
            if (!s) return null;
            const i = ((y & 15) << 8) | (pz << 4) | px;   // px/pz are already chunk-local
            return { sky: s.SkyLight ? nibbleAt(s.SkyLight, i) : -1, blk: s.BlockLight ? nibbleAt(s.BlockLight, i) : -1 };
          };
          const s0 = at(top), s1 = at(top - 1);
          histSky[(s0?.sky ?? -1) + 1]++; histBlk[(Math.max(s0?.blk ?? -1, s1?.blk ?? -1)) + 1]++;
          if ((s1?.sky ?? -1) >= 0) histSkyBelow[(s1.sky) + 1]++;
          if (s0 && s0.sky >= 0 && s0.sky <= 11) shade.push({ x: cx * 16 + px, y: top, z: cz * 16 + pz, sky: s0.sky });
          let blk = -1, blkY = 0;
          for (let y = top; y >= top - 10 && y >= minY; y--) {
            const v = at(y);
            if (v && v.blk > blk) { blk = v.blk; blkY = y; }
          }
          if (blk >= 12) torch.push({ x: cx * 16 + px, y: blkY, z: cz * 16 + pz, blk, sky: at(blkY)?.sky ?? -1 });
          if (s0 && s1 && s0.sky >= 13 && s1.sky >= 0 && s1.sky <= 5) mouth.push({ x: cx * 16 + px, y: top - 1, z: cz * 16 + pz, sky: s1.sky });
        }
      }
    }
  }
  rf.close();
}

const cluster = (list) => {
  const by = new Map();
  for (const c of list) {
    const k = `${c.x >> 4},${c.z >> 4}`;
    const a = by.get(k) ?? { n: 0, x: 0, y: 0, z: 0, best: 0 };
    a.n++; a.x += c.x; a.y += c.y; a.z += c.z;
    a.best = Math.max(a.best, c.blk ?? (15 - (c.sky ?? 15)));
    by.set(k, a);
  }
  return [...by.values()]
    .map((a) => ({ n: a.n, x: Math.round(a.x / a.n), y: Math.round(a.y / a.n), z: Math.round(a.z / a.n), best: a.best }))
    .sort((p, q) => (q.n - p.n) || (q.best - p.best)).slice(0, 10);
};

console.log(`sampled ${picked.length} region files, ${files.length} available`);
const row = (name, h) => console.log(name, h.map((v, i) => v ? `${i - 1}:${v}` : '').filter(String).join(' '));
row('sky at surface      ', histSky);
row('sky one below       ', histSkyBelow);
row('max block light top ', histBlk);
console.log('surface without full daylight:', JSON.stringify(cluster(shade)));
console.log('strong block light near the surface:', JSON.stringify(cluster(torch)));
console.log('daylight dropping straight down:', JSON.stringify(cluster(mouth)));
