// Dimension registry: which folder holds which dimension's region files, for vanilla layout
// (world/region, world/DIM-1/region, world/DIM1/region) and Fabric/data-pack layout
// (world/dimensions/<namespace>/<path>/region).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readNbt } from '../tools/nbt.mjs';

const VANILLA_NAME = { region: 'minecraft:overworld', 'DIM-1': 'minecraft:the_nether', DIM1: 'minecraft:the_end' };

export function listDims(worldRoot) {
  const out = [];
  if (fs.existsSync(path.join(worldRoot, 'region'))) {
    out.push({ id: VANILLA_NAME.region, dir: 'region' });
  }
  for (const d of fs.readdirSync(worldRoot)) {
    if (d === 'region' || d === 'dimensions') continue;
    if (fs.existsSync(path.join(worldRoot, d, 'region'))) {
      out.push({ id: VANILLA_NAME[d] ?? d, dir: `${d}/region` });
    }
  }
  const dimRoot = path.join(worldRoot, 'dimensions');
  if (fs.existsSync(dimRoot)) {
    for (const ns of fs.readdirSync(dimRoot)) {
      for (const p of fs.readdirSync(path.join(dimRoot, ns))) {
        const rel = `dimensions/${ns}/${p}/region`;
        if (fs.existsSync(path.join(worldRoot, rel))) out.push({ id: `${ns}:${p}`, dir: rel });
      }
    }
  }
  return out;
}

const RE_REGION = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/**
 * The world seed from `level.dat`, as a string, or `''` when it cannot be read.
 *
 * One gunzip of a ~600-byte file at boot, and it is what separates two saves living at the same path (a
 * replaced save, a restored-from-a-different-one directory) while staying identical for the same save
 * across a lifetime of play - which is what the payload cache's world level needs (shared/world-tag.mjs).
 * 1.18+ keeps it in `WorldGenSettings.seed`; older saves in `Data.Seed`. NBT longs arrive as BigInt.
 */
export function levelSeed(worldRoot) {
  try {
    const dat = zlib.gunzipSync(fs.readFileSync(path.join(worldRoot, 'level.dat')));
    const d = readNbt(dat).value?.Data;
    const s = d?.WorldGenSettings?.seed ?? d?.Seed;
    return s === null || s === undefined ? '' : String(s);
  } catch { return ''; }
}

/** Region file names present in a dimension -> chunk extent and file list (no file contents read). */
export function dimExtent(dir) {
  const files = fs.readdirSync(dir).filter(f => RE_REGION.test(f));
  const cells = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const f of files) {
    const m = RE_REGION.exec(f);
    cells.push({ rx: +m[1], rz: +m[2] });
    minX = Math.min(minX, +m[1]); maxX = Math.max(maxX, +m[1]);
    minZ = Math.min(minZ, +m[2]); maxZ = Math.max(maxZ, +m[2]);
  }
  const chunks = files.length ? files.length * 1024 : 0;   // upper bound; actual count needs headers
  return {
    regions: files.length,
    regionExtent: files.length ? { minX, maxX, minZ, maxZ } : null,
    chunkExtent: files.length
      ? { minX: minX * 32, maxX: maxX * 32 + 31, minZ: minZ * 32, maxZ: maxZ * 32 + 31 }
      : null,
    chunksUpperBound: chunks,
    cells,
  };
}
