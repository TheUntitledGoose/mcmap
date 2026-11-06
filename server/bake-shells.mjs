// One-off bake: turn every chunk of every dimension into a shell pack (height + surface state per
// column, 1 KB per chunk instead of ~100 KB of voxel payload), so the far view is a file read and not
// 37 000 NBT decodes.
//
//   node server/bake-shells.mjs [--world DarkRPG/world] [--out build/shells] [--dim <id>] [--force]
//
// Existing packs whose header stamp matches the current atlas are skipped, so a rerun after an
// interrupted run only does the rest. The stamp is the atlas identity: state ids are only meaningful
// against the atlas they were baked with, so re-baking assets invalidates every pack.
import fs from 'node:fs';
import path from 'node:path';
import { WorldService } from './world-service.mjs';
import { buildStateIds } from './chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { shellFromPayload, shellPlanes, SHELL_FRAME } from './shell.mjs';
import { OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_HEADER } from '../shared/chunk-format.mjs';
import { packBytes, ShellPack, overviewFromPacks, atlasStamp } from './shell-pack.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const WORLD = arg('world', 'DarkRPG/world');
const ASSETS = arg('assets', 'build/assets');
const OUT = arg('out', 'build/shells');
const CACHE = arg('cache', 'build/cache');
const ONLY = arg('dim', null);
const FORCE = argv.includes('--force');
// Re-cutting just the overview is a pass over the packs, not over the save: seconds instead of the
// 45-minute pack bake. Use it when the overview cell size changes.
const OV_ONLY = argv.includes('--overview-only');
const CELL = +arg('cell', 4);

const atlasStat = fs.statSync(path.join(ASSETS, 'atlas.json'));
const atlas = JSON.parse(fs.readFileSync(path.join(ASSETS, 'atlas.json'), 'utf8'));
// Atlas identity: its mtime plus the state count. Anything derived from state ids has to carry it.
const STAMP = atlasStamp(atlasStat, atlas.states.length);

const stateIds = buildStateIds(atlas.states.map((s) => s.k));
const cls = classifyStates(atlas.states, atlas.textures);
// Two different questions: is this block solid enough to hold a surface up (water is), and is it
// solid *and* opaque enough to paint a far column with (water is not).
const isSolid = (id) => cls.cube[id - 1] === 1;
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
// Water and ice hold a lake skin up and must not be counted as one: see server/shell.mjs.
const isFilm = (id) => cls.film[id - 1] === 1;
const svc = new WorldService(WORLD, stateIds, CACHE === 'none' ? null : CACHE, {
  isCubeState: isSolid, isPaintState: isPaint, isSolidState: isSolid, isFilmState: isFilm,
});

const regionName = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

function bakeDim(d) {
  const key = keyOf(d);
  const dir = path.join(OUT, key);
  fs.mkdirSync(dir, { recursive: true });
  const srcDir = d.dir;   // dimList() already joins the world root into it, and its `key` matches
  const regions = fs.readdirSync(srcDir).filter((f) => regionName.test(f))
    .map((f) => { const m = f.match(regionName); return { f, rx: +m[1], rz: +m[2] }; })
    .sort((a, b) => a.rx - b.rx || a.rz - b.rz);
  let done = 0, made = 0, chunks = 0;
  const t0 = Date.now();
  for (const r of regions) {
    const dest = path.join(dir, `${r.rx}_${r.rz}.bin`);
    if (!FORCE) {
      try {
        const p = new ShellPack(dest);
        if (p.stamp === STAMP) { done++; continue; }
      } catch { /* missing or unreadable: rebuild it */ }
    }
    const slots = [];
    for (let cz = r.rz * 32; cz < r.rz * 32 + 32; cz++) {
      for (let cx = r.rx * 32; cx < r.rx * 32 + 32; cx++) {
        const bytes = svc.chunkBytes(d.id, cx, cz);
        if (!bytes) continue;
        // Skylight is a property of the dimension, not of the renderer: the nether has no sky
        // arrays at all, so a shell column there must not be filed as standing in open daylight.
        const frame = shellFromPayload(bytes, { isPaint, isSolid, isFilm, hasSky: svc.dimHasSky(d) });
        if (!frame) continue;
        // The frame is exactly the four u16 planes the pack stores, so read them off its bytes
        // rather than re-deriving anything.
        const pl = shellPlanes(frame);
        slots.push([cx, cz, pl.h, pl.cover, pl.g, pl.state, pl.light, pl.band]);
        chunks++;
      }
    }
    fs.writeFileSync(dest, packBytes(r.rx, r.rz, STAMP, slots));
    made++;
    if ((made + done) % 25 === 0) {
      const rate = chunks / Math.max(0.001, Date.now() / 1000 - t0 / 1000);
      console.log(`  ${d.id}: ${made + done}/${regions.length} regions, ${chunks} chunks, ${rate.toFixed(0)}/s`);
    }
  }
  console.log(`${d.id}: ${made} packed, ${done} already current, ${chunks} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { dir, chunks };
}

function buildOverview(d, dir) {
  const ov = overviewFromPacks(dir, STAMP, d.chunkExtent, CELL);
  if (!ov.w || !ov.h) return console.log(`${d.id}: no overview (empty extent)`);
  // Frame: magic, version, cell, extent origin, grid size, then four u16 planes and one light
  // byte per cell.
  const head = Buffer.alloc(OVERVIEW_HEADER);
  head.write(OVERVIEW_MAGIC, 0, 'ascii');
  head.writeUInt16LE(OVERVIEW_VERSION, 8);
  head.writeUInt16LE(CELL, 10);
  head.writeUInt32LE(STAMP, 12);
  head.writeInt32LE(ov.x0, 16);
  head.writeInt32LE(ov.z0, 20);
  head.writeUInt16LE(ov.w, 24);
  head.writeUInt16LE(ov.h, 26);
  const out = Buffer.concat([head, Buffer.from(ov.height.buffer), Buffer.from(ov.state.buffer),
    Buffer.from(ov.ground.buffer), Buffer.from(ov.cover.buffer), Buffer.from(ov.light.buffer),
    Buffer.from(ov.band.buffer)]);
  const file = path.join(OUT, `overview-${keyOf(d)}.bin`);
  fs.writeFileSync(file, out);
  console.log(`${d.id}: overview ${ov.w}x${ov.h} cells of ${CELL} chunks -> ${file} (${(out.length / 1e6).toFixed(1)} MB)`);
}

// The directory names have to match what the server looks for, and the server derives them from the
// dimension's path *inside* the save (region, DIM-1/region, dimensions/<ns>/<path>/region). Deriving
// them from the joined host path instead silently produces packs the server cannot find.
const keyOf = (d) => { if (!d.key) throw new Error('dimList() must expose key'); return d.key; };
const dims = svc.dimList().filter((d) => !ONLY || d.id === ONLY || d.id.endsWith(`:${ONLY}`));
if (!dims.length) { console.error(`no dimension matched --dim ${ONLY}`); process.exit(1); }
for (const d of dims) {
  if (!d.chunkExtent) { console.log(`${d.id}: no chunk extent, skipping`); continue; }
  console.log(`${d.id}: ${d.chunkExtent.minX}..${d.chunkExtent.maxX} x ${d.chunkExtent.minZ}..${d.chunkExtent.maxZ} chunks`);
  const { dir } = OV_ONLY ? { dir: path.join(OUT, keyOf(d)) } : bakeDim(d);
  buildOverview(d, dir);
}
console.log(`stamp ${STAMP}`);
