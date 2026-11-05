import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from './nbt.mjs';
import { RegionFile, stateAtBigInt, bitsFor } from './region.mjs';

const WORLD = process.argv[2] ?? 'DarkRPG/world';
const log = (...a) => console.log(...a);

/* ---------- level.dat ---------- */
const raw = fs.readFileSync(path.join(WORLD, 'level.dat'));
const parsed = readNbt(zlib.gunzipSync(raw));
const lvl = parsed.value.Data ?? parsed.value;
log('=== level.dat ===');
log('name        :', lvl.LevelName);
log('DataVersion :', lvl.DataVersion);
log('version     :', lvl.Version?.Name, `(id ${lvl.Version?.Id})`, 'snapshot:', !!lvl.Version?.Snapshot);
log('spawn       :', lvl.SpawnX, lvl.SpawnY, lvl.SpawnZ);
log('gameType    :', lvl.GameType, 'hardcore:', lvl.hardcore, 'difficulty:', lvl.Difficulty);
log('generator   :', lvl.generatorName, lvl.generatorVersion, lvl.generatorType);
log('allowCommands/online:', lvl.allowCommands, lvl.OnlineMode);
if (lvl.WorldGenesis) log('time/daylight:', Number(lvl.Time), lvl.Daylight);

/* ---------- region extent ---------- */
const regDir = path.join(WORLD, 'region');
const re = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, total = 0, chunkTotal = 0;
const sizes = [];
for (const f of fs.readdirSync(regDir)) {
  const m = re.exec(f); if (!m) continue;
  const [rx, rz] = [+m[1], +m[2]];
  minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
  minZ = Math.min(minZ, rz); maxZ = Math.max(maxZ, rz);
  total++;
  const r = new RegionFile(path.join(regDir, f));
  const n = r.countChunks(); r.close();
  chunkTotal += n;
  sizes.push({ f, rx, rz, n, bytes: fs.statSync(path.join(regDir, f)).size });
}
log('\n=== overworld regions ===');
log(`region files   : ${total}`);
log(`region coord rng: x ${minX}..${maxX}  z ${minZ}..${maxZ}`);
log(`chunk block rng : x ${minX * 32}..${maxX * 32 + 31}  z ${minZ * 32}..${maxZ * 32 + 31}`);
log(`chunks present : ${chunkTotal} (avg ${(chunkTotal / total).toFixed(1)}/region)`);
sizes.sort((a, b) => b.bytes - a.bytes);
log('largest        :', sizes.slice(0, 3).map(s => `${s.f} ${(s.bytes / 1e6).toFixed(1)}MB ${s.n}c`).join(' | '));

/* ---------- decode one chunk end-to-end ---------- */
const spawnRX = Math.floor(lvl.SpawnX / 512), spawnRZ = Math.floor(lvl.SpawnZ / 512);
const regPath = path.join(regDir, `r.${spawnRX}.${spawnRZ}.mca`);
log(`\n=== chunk probe: spawn region ${path.basename(regPath)} ===`);
if (!fs.existsSync(regPath)) { log('missing region for spawn; scanning nearest'); }
const pick = fs.existsSync(regPath) ? regPath
  : sizes.sort((a, b) => b.n - a.n)[0] && path.join(regDir, sizes.sort((a, b) => b.n - a.n)[0].f);
const rgn = new RegionFile(pick);
let found = null;
for (let z = 0; z < 32 && !found; z++) for (let x = 0; x < 32; x++) {
  if (rgn.entry(x, z)) { found = { x, z }; break; }
}
const comp = rgn.readChunkNbtBytes(found.x, found.z);
const bytes = zlib.inflateSync(comp);
const cParsed = readNbt(bytes); const c = cParsed.value.Chunk ? { ...cParsed.value, ...cParsed.value.Chunk } : cParsed.value;
log('compressed     :', comp.length, '-> inflated', bytes.length);
log('DataVersion    :', c.DataVersion, 'status:', c.Status);
log('xPos/zPos/yPos :', c.xPos, c.zPos, c.yPos, '(yMin', c.yMin, ')');
log('sections       :', c.sections.length);
const dv = c.DataVersion;
const oldLayout = dv < 2920; // 1.16.220 introduced cross-long-boundary packing
log('packed layout  :', oldLayout ? 'pre-1.16.220 (padded)' : '1.16.220+ (cross-boundary)');

let airStates = 0, totalBlocks = 0;
const paletteSample = new Map();
for (const s of c.sections) {
  const bits = bitsFor(s.BlockStatePalette.length, oldLayout);
  const longs = s.BlockStates;
  totalBlocks += 4096;
  if (s.Y === c.sections[0].Y) {
    log(`\nsection Y=${Number(s.Y)} palette=${s.BlockStatePalette.length} bits=${bits} longs=${longs.length}`);
    for (let i = 0; i < 4096; i++) {
      const id = stateAtBigInt(longs, bits, i);
      const st = s.BlockStatePalette[Number(id)];
      if (Number(st.Id) === 0) airStates++;
      const key = `${st.Id} ${JSON.stringify(st.Properties ?? {})}`;
      if (!paletteSample.has(key)) paletteSample.set(key, 0);
      paletteSample.set(key, paletteSample.get(key) + 1);
    }
    log('decoded column contents:');
    for (const [k, n] of [...paletteSample].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      log(`   ${String(n).padStart(5)}  ${k}`);
    }
  }
  // verify long count matches the packing rule
  const expected = oldLayout
    ? Math.ceil(4096 / Math.floor(64 / bits)) * bits / 64 * 1 // rough
    : Math.ceil((4096 * bits) / 64);
  if (!oldLayout && longs.length !== expected) {
    log(`!! longs mismatch: got ${longs.length} expected ${expected}`);
  }
}
log('\nair blocks in first section:', airStates, '/', totalBlocks);
log('SkyLight bytes:', c.SkyLight?.length, 'BlockLight:', c.BlockLight?.length,
    'heightmap keys:', Object.keys(c.Heightmaps ?? {}));
rgn.close();
