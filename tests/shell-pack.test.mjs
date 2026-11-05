// Shell packs (server/shell-pack.mjs): the precomputed far view. Two things have to be true or the
// whole layer is a lie - a pack must answer exactly what deriving the shell from the chunk would have
// answered, and it must refuse to serve when the atlas (and therefore every state id in it) moved on.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { packBytes, ShellPack, overviewFromPacks, atlasStamp, PACK_PCTL } from '../server/shell-pack.mjs';
import { shellFromPayload, shellFrameCols, SHELL_FRAME } from '../server/shell.mjs';
import {
  SHELL_MAGIC, SHELL_HEADER, SHELL_COLS, SHELL_COLS_BYTES, SHELL_LIGHT_BYTES, HEIGHT_BIAS, OVERVIEW_MAGIC,
} from '../shared/chunk-format.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { packLight } from '../shared/light.mjs';
import { openShellFrame, openOverview } from '../web/js/payload.js';
import { meshOverview, faceSprites } from '../web/js/shell-mesh.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { Assets } from '../web/js/assets.js';

const SHELLS = 'build/shells';
const atlasPath = path.join('build', 'assets', 'atlas.json');
// The small custom dimension is the fast one; the overworld is the one the user actually looks at, and
// it is the only one with a lake, plants, snow and 200 m player builds to get the planes wrong on.
const DIM = 'spellbladenext:glassocean';
const DIMS = [DIM, 'minecraft:overworld'];

/**
 * Two populated chunk columns with recognisable shapes. Heights are biased as a frame stores them, and
 * every column carries all four planes: the surface the eye sees, what sits at it, the ground under it
 * and the block that paints it. A third of the columns pretend to be water, so the pack round trip and
 * the grid reduction both have to carry the difference rather than collapse back to two planes.
 */
function fakeSlots() {
  const out = [];
  for (const [cx, cz, fill] of [[0, 0, (x, z) => 60 + (x & 7)], [1, 0, (x, z) => 70 - (z & 3)]]) {
    const h = new Uint16Array(SHELL_COLS), cover = new Uint16Array(SHELL_COLS);
    const g = new Uint16Array(SHELL_COLS), s = new Uint16Array(SHELL_COLS);
    const li = new Uint8Array(SHELL_COLS);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const k = (z << 4) | x, top = fill(x, z);
        const wet = (x + z) % 3 === 0;
        h[k] = top + HEIGHT_BIAS;
        g[k] = (wet ? top - 4 : top) + HEIGHT_BIAS;
        cover[k] = wet ? 3 : 1 + ((x * 16 + z) % 7);
        s[k] = 1 + ((x * 16 + z) % 7);
        // light travels with the column it belongs to, or a coarse cell paints bright ground in a cave
        li[k] = packLight(Math.min(15, top - 50), wet ? 5 : 0);
      }
    }
    out.push([cx, cz, h, cover, g, s, li]);
  }
  return out;
}

const tmp = fs.mkdtempSync('build/tmp-pack-');
const packFile = path.join(tmp, 'r.bin');
fs.writeFileSync(packFile, packBytes(0, 0, 4242, fakeSlots()));

test('pack: columns survive the deflate round trip', () => {
  const pk = ShellPack.load(packFile, 4242);
  assert.ok(pk, 'the pack loaded');
  assert.deepEqual([pk.rx, pk.rz, pk.stamp], [0, 0, 4242]);
  for (const [cx, cz, h, cover, g, st, li] of fakeSlots()) {
    const got = pk.cols(cx, cz);
    assert.ok(got, `chunk ${cx},${cz} is present`);
    assert.deepEqual([...got.h], [...h], `heights for ${cx},${cz}`);
    assert.deepEqual([...got.cover], [...cover], `cover for ${cx},${cz}`);
    assert.deepEqual([...got.g], [...g], `ground for ${cx},${cz}`);
    assert.deepEqual([...got.s], [...st], `states for ${cx},${cz}`);
    assert.deepEqual([...got.light], [...li], `light for ${cx},${cz}`);
  }
  assert.equal(pk.cols(20, 20), null, 'an empty slot is absent, not zero-filled');
  // Deflating heightmaps has to pay for itself, or the file buys nothing.
  const packed = fs.statSync(packFile).size;
  assert.ok(packed < 1024 * 512, `packed ${packed} of ${1024 * 512} raw bytes`);
  pk.free();
});

test('pack: a stale atlas stamp, or a missing file, serves nothing', () => {
  assert.ok(ShellPack.load(packFile), 'no stamp asked for, no opinion given');
  assert.equal(ShellPack.load(packFile, 4243), null, 'a different atlas must not be served');
  assert.equal(ShellPack.load(path.join(tmp, 'absent.bin'), 4242), null, 'no file, no pack');
});

test('pack: re-assembling a frame from stored columns gives the same bytes', () => {
  const [cx, cz, h, cover, g, st, li] = fakeSlots()[0];
  const frame = shellFrameCols(cx, cz, h, cover, g, st, li);
  assert.equal(frame.length, SHELL_FRAME, 'four planes of u16 plus a light byte per column');
  assert.equal(SHELL_FRAME, SHELL_HEADER + SHELL_COLS * SHELL_COLS_BYTES + SHELL_LIGHT_BYTES);
  assert.equal(frame.subarray(0, 8).toString('ascii'), SHELL_MAGIC);
  const got = openShellFrame(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length));
  assert.equal(got.cx, cx);
  for (let i = 0; i < SHELL_COLS; i++) {
    assert.equal(got.height[i], h[i], `column ${i} height`);
    assert.equal(got.cover[i], cover[i], `column ${i} cover`);
    assert.equal(got.ground[i], g[i], `column ${i} ground`);
    assert.equal(got.state[i], st[i], `column ${i} state`);
    assert.equal(got.light[i], li[i], `column ${i} light`);
  }
});

test('overview: a dimension of packs reduces to one grid of columns', () => {
  const dir = fs.mkdtempSync('build/tmp-ov-');
  try {
    fs.writeFileSync(path.join(dir, '0_0.bin'), packBytes(0, 0, 7, fakeSlots()));
    const ov = overviewFromPacks(dir, 7, { minX: 0, maxX: 31, minZ: 0, maxZ: 31 }, 2);
    assert.deepEqual([ov.w, ov.h, ov.x0, ov.z0], [16, 16, 0, 0], '32x32 chunks in cells of 2');
    // chunk (1,0) tops out at 70, chunk (0,0) at 67; only those two chunks exist, so the cell of the
    // first row takes 70 and the rows below it, with nothing baked, stay empty.
    assert.equal(ov.height[0], 70 + HEIGHT_BIAS, 'a cell takes the taller of its chunks, still biased');
    assert.ok(ov.state[0] > 0, 'and the state of that tallest column');
    // The other two planes belong to that same column, or the grid would paint one block at another
    // block's height.
    let want = -1, wantK = -1;
    for (const [cx, cz, h] of fakeSlots()) {
      if (cx !== 1 || cz !== 0) continue;
      for (let i = 0; i < SHELL_COLS; i++) if (h[i] > want) { want = h[i]; wantK = i; }
    }
    assert.equal(ov.cover[0], fakeSlots()[1][3][wantK], 'the cell keeps the cover of the column it took');
    assert.equal(ov.ground[0], fakeSlots()[1][4][wantK], 'and the ground of that column');
    assert.equal(ov.light[0], fakeSlots()[1][6][wantK], 'and the light of that column');
    assert.equal(ov.height[ov.w], 0, 'a cell with nothing baked has no height');
    assert.equal(ov.height[ov.w * ov.h - 1], 0, 'nor does the far corner');
    const stale = overviewFromPacks(dir, 8, { minX: 0, maxX: 31, minZ: 0, maxZ: 31 }, 2);
    assert.ok([...stale.height].every((v) => v === 0), 'a stale stamp means no heights at all');
    assert.ok([...stale.state].every((v) => v === 0), 'a stale stamp means no states at all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- against the real world, when it has been baked ------------------------------------------
// The skip test asks the server itself rather than guessing file names: the dimension directory is
// named from the save's own layout, and a test that re-derived it would drift the way the bake did.
const baked = fs.existsSync(SHELLS) && fs.existsSync(atlasPath) && DIMS.every((d) => !!service().svc.overviewBytes(d));

function service() {
  const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
  const cls = classifyStates(atlas.states, atlas.textures);
  const ids = buildStateIds(atlas.states.map((s) => s.k));
  return {
    atlas,
    svc: new WorldService('DarkRPG/world', ids, 'build/cache', {
      // The same policy bake-shells.mjs bakes with, or the oracle and the pack disagree by design.
      isCubeState: (id) => cls.cube[id - 1] === 1,
      isPaintState: (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1,
      isSolidState: (id) => cls.cube[id - 1] === 1,
      packDir: SHELLS,
      stamp: atlasStamp(fs.statSync(atlasPath), atlas.states.length),
    }),
  };
}

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

for (const DIM of DIMS) test(`worldd: a baked pack answers exactly what the chunk would have (${DIM})`, (t) => {
  if (!baked) return t.skip('build/shells not baked (run node server/bake-shells.mjs)');
  const { svc } = service();
  let checked = 0, packed = 0;
  for (const [cx, cz] of [[0, 0], [4, 8], [-2, 6], [100, -20], [31, 31]]) {
    const fromPack = svc.shellBytes(DIM, cx, cz);
    if (!fromPack) continue;
    if (svc.packFor(svc.resolve(DIM), cx >> 5, cz >> 5)) packed++;
    // The oracle: decode the chunk and derive the shell the way the live server did before packs.
    const derived = shellFromPayload(svc.chunkBytes(DIM, cx, cz), {
      isPaint: svc.isPaintState, isSolid: svc.isSolidState,
      // Skylight belongs to the dimension: bake-shells.mjs passes the same flag, and without it the
      // nether oracle invents daylight the pack never stored.
      hasSky: svc.dimHasSky(svc.resolve(DIM)),
    });
    assert.equal(fromPack.length, derived.length, `frame length for ${cx},${cz}`);
    assert.equal(fromPack.subarray(0, 8).toString('ascii'), SHELL_MAGIC);
    const a = openShellFrame(asArrayBuffer(fromPack));
    const b = openShellFrame(asArrayBuffer(derived));
    for (let i = 0; i < SHELL_COLS; i++) {
      for (const plane of ['height', 'cover', 'ground', 'state', 'light']) {
        assert.equal(a[plane][i], b[plane][i], `${cx},${cz} column ${i} ${plane}`);
      }
    }
    checked++;
  }
  assert.ok(checked >= 3, `only ${checked} of the sample chunks exist`);
  // Guard the test against its own fallback: comparing the pack path to itself would pass forever.
  assert.ok(packed >= 3, `only ${packed} of ${checked} sample chunks came from a pack`);
});

for (const DIM of DIMS) test(`worldd: the overview frame covers the dimension and matches the packs (${DIM})`, (t) => {
  if (!baked) return t.skip('build/shells not baked');
  const { svc } = service();
  const buf = svc.overviewBytes(DIM);
  assert.ok(buf, 'the overview is served');
  assert.equal(buf.subarray(0, 8).toString('ascii'), OVERVIEW_MAGIC);
  const ov = openOverview(asArrayBuffer(buf));
  const d = svc.dimList().find((x) => x.id === DIM);
  assert.equal(ov.w, Math.ceil((d.chunkExtent.maxX - d.chunkExtent.minX + 1) / ov.cell));
  assert.equal(ov.h, Math.ceil((d.chunkExtent.maxZ - d.chunkExtent.minZ + 1) / ov.cell));
  // Sample painted cells rather than a fixed grid: this dimension is sparse, so a blind sample would
  // mostly land on nothing and prove nothing.
  const painted = [];
  for (let j = 0; j < ov.h; j++) for (let i = 0; i < ov.w; i++) if (ov.stateAt(i, j)) painted.push([i, j]);
  assert.ok(painted.length > 100, `${painted.length} painted cells`);
  let cells = 0, spans = 0;
  for (let n = 0; n < 12; n++) {
    const [i, j] = painted[Math.floor((painted.length * n) / 12)];
    const [cx0, cz0, cx1, cz1] = ov.cellChunks(i, j);
    // Two rules, and they are different rules. (1) A cell's height is *copied* - it is one real column
    // height from under the cell, never an average, so it has to appear among the columns there.
    // (2) Which real column it copies is the documented choice: the 80th percentile of each chunk's own
    // columns, then the same percentile across the chunk representatives. Rule 2 is what stops one lone
    // 200 m tower turning a 64x64 block cell into a plateau, and rule 1 is what stops the grid inventing
    // terrain that is not in the world. Reproduce rule 2 here rather than trusting the server's own loop.
    const cols = new Set(), reps = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const sh = svc.shellBytes(DIM, cx, cz);
        if (!sh) continue;
        const f = openShellFrame(asArrayBuffer(sh));
        const hs = [];
        for (let k = 0; k < SHELL_COLS; k++) {
          const h = f.height[k] - HEIGHT_BIAS;
          if (f.height[k]) { hs.push(h); cols.add(h); }
        }
        if (!hs.length) continue;
        hs.sort((a, b) => a - b);
        reps.push(hs[Math.min(hs.length - 1, Math.floor(hs.length * PACK_PCTL))]);
      }
    }
    assert.ok(cols.size, `cell ${i},${j} is painted but has no chunk under it`);
    reps.sort((a, b) => a - b);
    const want = reps[Math.min(reps.length - 1, Math.floor(reps.length * PACK_PCTL))];
    const cellH = ov.heightAt(i, j);
    assert.equal(cellH, want, `cell ${i},${j} height ${cellH} is not its chunks' ${PACK_PCTL} percentile`);
    assert.ok(cols.has(cellH), `cell ${i},${j} height ${cellH} is not a column height under it`);
    if (new Set(reps).size > 1) spans++;
    cells++;
  }
  console.log(`# overview: ${painted.length} painted cells of ${ov.w}x${ov.h}, ${spans}/${cells} sampled cells span more than one height`);
  assert.ok(cells >= 12, `only ${cells} sample cells had chunks`);
});

test('overview mesh: one top per cell, cliffs on the steps, nothing under the skin', (t) => {
  if (!baked) return t.skip('build/shells not baked');
  const atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
  const geo = fs.readFileSync('build/assets/geometry.bin');
  const assets = new Assets(atlas, asArrayBuffer(geo));
  const { svc } = service();
  const ov = openOverview(asArrayBuffer(svc.overviewBytes(DIM)));

  const { stream, stats } = meshOverview(assets, ov, { minStep: 2, trackStates: true });
  assert.ok(stats.columns > 100, `${stats.columns} cells painted`);
  assert.ok(stats.walls > 0, 'the grid has at least one step in it');
  assert.equal(stream.count % 6, 0, 'verts come in triangles');
  assert.equal(stream.stateIds.length, stream.count / 6, 'one state id per quad');
  const quads = stream.stateIds.length;

  const { stats: s2 } = meshOverview(assets, ov, { minStep: 2, skip: () => true });
  assert.equal(s2.columns, 0, 'skip-all paints nothing');

  // Skipping one cell must cost exactly that cell.
  const first = ov.cellChunks(0, 0);
  const inFirst = ([cx, cz]) => cx >= first[0] && cx <= first[2] && cz >= first[1] && cz <= first[3];
  const { stats: s3 } = meshOverview(assets, ov, { minStep: 2, skip: (cx, cz) => inFirst([cx, cz]) });
  assert.equal(s3.columns, stats.columns - (ov.stateAt(0, 0) ? 1 : 0), 'only that cell disappears');

  // A band of rows is a strict subset: rows must not leak into each other or double count.
  const half = Math.floor(ov.h / 2);
  const a = meshOverview(assets, ov, { minStep: 2, row0: 0, rows: half });
  const b = meshOverview(assets, ov, { minStep: 2, row0: half, rows: ov.h - half });
  assert.ok(a.stats.columns > 0 && b.stats.columns > 0, 'both halves painted something');
  assert.equal(a.stats.columns + b.stats.columns, stats.columns, 'the bands tile the grid');

  // Every quad carries a colour in range, from its own cell sprite mean.
  const per = new Map();
  let checked = 0;
  for (let q = 0; q < quads; q++) {
    const id = stream.stateIds[q];
    const up = faceSprites(assets, id, per)[1];
    if (!up || up.cell.kind === 3) continue;
    const o = q * 6;                                  // 6 verts per quad, 4 colour bytes each
    for (let k = 0; k < 3; k++) {
      const v = stream.color[(o + 0) * 4 + k] / 255;
      assert.ok(v >= 0 && v <= 1, `vertex colour out of range: ${v}`);
    }
    checked++;
    if (checked > 300) break;
  }
  assert.ok(checked > 100, `only ${checked} quads had a sprite to check`);
});

test.after?.('cleanup', () => fs.rmSync(tmp, { recursive: true, force: true }));
