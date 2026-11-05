// M6 step 1+2: what lighting the save actually carries, and what it would cost to ship it.
//
// Two questions, answered with numbers instead of assumptions:
//  A. Per section, is there a SkyLight/BlockLight nibble array, is it uniform (so a marker would do),
//     and how do Starlight's `starlight.*_state` markers correlate with that?  (marker semantics were
//     guessed from two chunks; here is the cross-tab over a real sample.)
//  B. Sections with no blocks and no light arrays at all — are they above the chunk's heightmap top
//     (so sky must be 15) or below it (so sky must be 0)?  That decides the "absent means what?" rule
//     for the payload, and it is the difference between a cave reading black and reading sunlit.
//
// It also prices the work: today's chunk payload vs the same payload with light added, compressed,
// because the wire already gzips.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { WorldService, compress } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { readNbt } from './nbt.mjs';
import { RegionFile } from './region.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {});
const DIMS = (process.env.DIMS || 'minecraft:overworld,minecraft:the_nether,minecraft:the_end')
  .split(',').map((s) => s.trim());
const PER_REGION = +(process.env.PER_REGION || 8);      // chunks sampled per region file
const REGIONS = +(process.env.REGIONS || 6);            // region files sampled per dimension

// Spread samples across the dimension rather than reading neighbours of one chunk.
const sampleChunks = (dim) => {
  const d = svc.dimList().find((x) => x.id === dim);
  if (!d) return [];
  const dirs = [d.dir];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f);
      if (m) files.push({ dir, rx: +m[1], rz: +m[2], path: `${dir}/${f}` });
    }
  }
  files.sort((a, b) => (a.rx - b.rx) || (a.rz - b.rz));
  const step = Math.max(1, Math.floor(files.length / REGIONS));
  const out = [];
  for (let i = 0; i < files.length && out.length < REGIONS * PER_REGION; i += step) {
    const { path, rx, rz } = files[i];
    let rf;
    try { rf = new RegionFile(path); } catch { continue; }
    let n = 0;
    // RegionFile.entry() takes LOCAL 0..31 coords; the payload/store wants global ones.
    for (let cz = 0; cz < 32 && n < PER_REGION; cz += 7) {
      for (let cx = 0; cx < 32 && n < PER_REGION; cx += 5) {
        if (rf.readChunkNbtBytes(cx, cz)) {
          out.push({ path, lx: cx, lz: cz, cx: rx * 32 + cx, cz: rz * 32 + cz });
          n++;
        }
      }
    }
    rf.close();
  }
  return out;
};

const nibStats = (arr) => {
  if (!arr) return null;
  let mn = 15, mx = 0, sum = 0;
  for (const b of arr) {
    const lo = b & 15, hi = (b >> 4) & 15;
    if (lo < mn) mn = lo; if (lo > mx) mx = lo;
    if (hi < mn) mn = hi; if (hi > mx) mx = hi;
    sum += lo + hi;
  }
  return { n: arr.length, mn, mx, mean: sum / (arr.length * 2), uniform: mn === mx ? mn : null };
};

const acc = (dim) => ({
  dim, chunks: 0, sections: 0, withBlocks: 0, emptyNoLight: 0,
  skyArr: 0, blkArr: 0, skyUniform: 0, blkUniform: 0, skyNonuniform: 0, blkNonuniform: 0,
  markerSky: new Map(), markerBlk: new Map(),
  crosstab: new Map(),          // "sky marker -> array present?" counts
  aboveTop: 0, belowTop: 0,     // the empty/unmarked sections, split by heightmap position
  topVoxelSky: { n: 0, v15: 0, other: new Map() },
  payNow: 0, payLight: 0, payNowGz: 0,
});

const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

const rfiles = new Map();
for (const dim of DIMS) {
  const a = acc(dim);
  for (const s of sampleChunks(dim)) {
    let rf = rfiles.get(s.path);
    if (!rf) { rf = new RegionFile(s.path); rfiles.set(s.path, rf); }
    let raw = null;
    try { raw = readNbt(zlib.inflateSync(rf.readChunkNbtBytes(s.lx, s.lz))).value; } catch { raw = null; }
    if (!raw || !raw.sections) continue;
    a.chunks++;
    const yTop = Math.max(...raw.sections.map((x) => Number(x.Y)));
    // Proxy for "where the build-up ends": the highest section index that has any non-air state.
    const topBlockSec = Math.max(-99, ...raw.sections.map((x) => (x.block_states &&
      x.block_states.palette.some((q, i) => i && q.Name !== 'minecraft:air')) ? Number(x.Y) : -99));
    const payload = svc.chunkBytes(dim, s.cx, s.cz);
    if (payload) { a.payNow += payload.length; a.payNowGz += compress(payload).length; }
    let lightBytes = 0;
    for (const sec of raw.sections) {
      a.sections++;
      const Y = Number(sec.Y);
      const bs = sec.block_states;
      const nonair = bs ? bs.palette.reduce((n, p, i) => n + (i && p.Name !== 'minecraft:air' ? 1 : 0), 0) : 0;
      if (nonair) a.withBlocks++;
      const sk = nibStats(sec.SkyLight), bl = nibStats(sec.BlockLight);
      const mkS = sec['starlight.skylight_state'], mkB = sec['starlight.blocklight_state'];
      if (sk) { a.skyArr++; if (sk.uniform !== null) a.skyUniform++; else a.skyNonuniform++; }
      if (bl) { a.blkArr++; if (bl.uniform !== null) a.blkUniform++; else a.blkNonuniform++; }
      bump(a.markerSky, mkS === undefined ? 'absent' : String(mkS));
      bump(a.markerBlk, mkB === undefined ? 'absent' : String(mkB));
      bump(a.crosstab, `sky mk=${mkS === undefined ? '-' : mkS} arr=${sk ? (sk.uniform === null ? 'varies' : 'uniform ' + sk.uniform) : 'no'}`);
      // The question that decides the absent-section rule.
      if (!sk && !bl && !nonair) {
        a.emptyNoLight++;
        // Above the built-up terrain means "open sky", i.e. sky 15; at or below it means 0.
        // (Chunk-level proxy, deliberately: the per-column heightmap answer comes next.)
        if (Y > topBlockSec) a.aboveTop++; else a.belowTop++;
      }
      // What does the topmost array say the sky is at the very top of the chunk?
      if (sk && Y === yTop) { a.topVoxelSky.n++; if (sk.mx === 15) a.topVoxelSky.v15++; else bump(a.topVoxelSky.other, String(sk.mx)); }
      if (sk) lightBytes += sk.uniform === null ? 1024 : 1;
      if (bl) lightBytes += bl.uniform === null ? 1024 : 1;
      if (!sk && !bl) lightBytes += 2;   // marker-only sections still need the marker recorded
    }
    a.payLight += payload ? compress(payload).length + lightBytes + 32 : 0;
  }
  const f = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '-';
  console.log(JSON.stringify({
    dim: a.dim, chunks: a.chunks, sections: a.sections, sectionsWithBlocks: a.withBlocks,
    arrays: { sky: a.skyArr, skyUniform: a.skyUniform, skyVaries: a.skyNonuniform, blk: a.blkArr, blkUniform: a.blkUniform, blkVaries: a.blkNonuniform },
    markerSky: Object.fromEntries(a.markerSky), markerBlk: Object.fromEntries(a.markerBlk),
    crosstab: Object.fromEntries([...a.crosstab].sort()),
    emptyNoLightSections: a.emptyNoLight, aboveHeightmapTop: a.aboveTop, belowHeightmapTop: a.belowTop,
    topSectionSkyArray: { sections: a.topVoxelSky.n, reaching15: a.topVoxelSky.v15, maxBelow15: Object.fromEntries(a.topVoxelSky.other) },
    payloadBytesNow: a.payNow, payloadGzNow: a.payNowGz, payloadGzWithLight: a.payLight,
    lightOverheadPct: a.payNowGz ? `+${(100 * (a.payLight - a.payNowGz) / a.payNowGz).toFixed(1)}%` : '-',
    perChunkGzNow: Math.round(a.payNowGz / Math.max(1, a.chunks)), perChunkGzWithLight: Math.round(a.payLight / Math.max(1, a.chunks)),
  }, null, 1));
}
