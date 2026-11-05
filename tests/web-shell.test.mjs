// Heightmap shell (M5): worldd builds a shell from a chunk payload, the browser reads it back and
// meshes it. Everything here runs against real chunks from the DarkRPG save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { shellFromPayload, SHELL_FRAME } from '../server/shell.mjs';
import { buildStateIds, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { SHELL_MAGIC, SHELL_COLS, HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets, decodeFaceCode } from '../web/js/assets.js';
import { openShellFrame, openShellBatch } from '../web/js/payload.js';
import { meshShell, meshShellPatch, faceSprites, blendFor } from '../web/js/shell-mesh.js';
import { tintOf } from '../web/js/mesher.js';
import { quadNormal } from '../shared/faces.mjs';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {
  isCubeState: (id) => cls.cube[id - 1] === 1,
});
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

test('shell: frame round-trips through the browser reader', () => {
  const raw = svc.chunkBytes('minecraft:overworld', 3, 3);
  assert.ok(raw, 'chunk 3,3 must exist');
  const frame = shellFromPayload(raw);
  assert.equal(frame.length, SHELL_FRAME, 'a shell is one fixed-size frame');
  assert.equal(frame.length % 4, 0, 'batch frames must stay 4-byte aligned');
  assert.equal(frame.subarray(0, 8).toString('ascii'), SHELL_MAGIC);

  const s = openShellFrame(ab(frame));
  assert.equal(s.cx, 3);
  assert.equal(s.cz, 3);
  assert.equal(s.height.length, SHELL_COLS);

  // Heights come straight from WORLD_SURFACE, so the silhouette matches the voxels exactly.
  const c = openChunk(raw);
  for (let i = 0; i < SHELL_COLS; i++) assert.equal(s.height[i], c.height[i], `column ${i} height`);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      assert.equal(s.surfaceAt(x, z), c.height[(z << 4) | x] - HEIGHT_BIAS, `surfaceAt ${x},${z}`);
    }
  }
});

test('shell: the column state is a cube, not the flower on top of it', () => {
  const raw = svc.chunkBytes('minecraft:overworld', 3, 3);
  const s = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3)));
  const c = openChunk(raw);
  const MAX_DROP = 5;
  let cubes = 0, filled = 0, notCube = 0;
  for (let i = 0; i < SHELL_COLS; i++) {
    const id = s.state[i];
    if (!id) continue;
    filled++;
    const x = i & 15, z = i >> 4;
    const top = c.height[i] - HEIGHT_BIAS;
    // the state must come from the surface column itself, never from a different column
    const inColumn = [0, 1, 2, 3, 4, 5].some((k) => c.stateAt(x, top - k, z) === id);
    assert.ok(inColumn, `state ${atlas.states[id - 1].k} is not in column ${x},${z}`);
    if (cls.cube[id - 1] === 1) { cubes++; continue; }
    // Anything still non-cube (a five-block-tall sugarcane, say) must genuinely have no cube
    // within reach, or the walk-down missed it.
    notCube++;
    const reach = Array.from({ length: MAX_DROP + 1 }, (_, k) => c.stateAt(x, top - k, z));
    assert.ok(!reach.some((v) => v && cls.cube[v - 1] === 1),
      `column ${x},${z} kept ${atlas.states[id - 1].k} with a cube in reach`);
  }
  assert.ok(filled > 200, `most columns should be filled, got ${filled}`);
  assert.ok(cubes >= filled * 0.9, `at least 90% of columns should resolve to a cube, got ${cubes}/${filled}`);
  assert.ok(notCube < 26, `too many unresolved columns: ${notCube}`);
});

test('shell: batches carry one frame per chunk, holes included', () => {
  const batch = svc.shellBatchBytes('minecraft:overworld', 2, 2, 3, 3);
  const frames = openShellBatch(ab(batch));
  assert.equal(frames.length, 9);
  const present = frames.filter(Boolean);
  assert.ok(present.length >= 8, `expected a nearly full 3x3, got ${present.length}`);
  for (const s of present) {
    assert.ok(s.cx >= 2 && s.cx <= 4 && s.cz >= 2 && s.cz <= 4, 'frame coordinates out of range');
    assert.ok(s.state.some((v) => v !== 0), 'a present chunk must have at least one column');
  }
  // the 1x1 endpoint and the batch must agree byte for byte
  const one = svc.shellBytes('minecraft:overworld', 3, 3);
  const hit = present.find((s) => s.cx === 3 && s.cz === 3);
  assert.deepEqual(Array.from(hit.height), Array.from(openShellFrame(ab(one)).height));
});

test('shell mesh: columns get a top plus skirts, and colours match the atlas', () => {
  const get = (cx, cz) => {
    const b = svc.shellBytes('minecraft:overworld', cx, cz);
    return b ? openShellFrame(ab(b)) : null;
  };
  const one = meshShell(assets, get(3, 3), { nb: get });
  const s = one.stream;
  assert.ok(one.stats.columns > 200, `expected surface columns, got ${one.stats.columns}`);
  assert.equal(s.count % 6, 0, 'quads emit whole triangles');
  assert.equal(s.count, (one.stats.columns + one.stats.walls) * 6, 'one quad per emitted face');
  assert.ok(one.stats.walls > 0, 'a real surface has height variation');

  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.count * 3; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = s.position[i + k];
      assert.ok(Number.isFinite(v), 'position must be finite');
      min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
    }
  }
  // chunk 3,3 spans x 48..63; walls may not stretch more than the skirt cap
  assert.ok(min[0] >= 47 && max[0] <= 64, `x range ${min[0]}..${max[0]} left the chunk`);
  assert.ok(min[2] >= 47 && max[2] <= 64, `z range ${min[2]}..${max[2]} left the chunk`);
  for (let i = 0; i < s.count * 2; i++) assert.ok(s.uv[i] >= 0 && s.uv[i] <= 1, 'uv must stay in the atlas');
  let lit = 0;
  for (let i = 0; i < s.count * 4; i += 4) if (s.color[i] > 0) lit++;
  assert.equal(lit, s.count, 'every vertex needs a non-black shade');

  // deterministic: same shells, same bytes
  const again = meshShell(assets, get(3, 3), { nb: get });
  assert.deepEqual(Array.from(again.stream.color), Array.from(s.color), 'shells must be deterministic');
});

test('shell mesh: knowing the neighbour chunk closes the border skirt', () => {
  const cache = new Map();
  const get = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (!cache.has(k)) {
      const b = svc.shellBytes('minecraft:overworld', cx, cz);
      cache.set(k, b ? openShellFrame(ab(b)) : null);
    }
    return cache.get(k);
  };
  // Mesh the nine chunks separately (each with unknown borders) and add up.
  let soloColumns = 0, soloWalls = 0;
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      const sh = get(2 + i, 2 + j);
      if (!sh) continue;
      const r = meshShell(assets, sh, { maxSkirt: 8 });
      soloColumns += r.stats.columns;
      soloWalls += r.stats.walls;
    }
  }
  const patch = meshShellPatch(assets, get, 2, 2, 3, 3, { cap: 8192, maxSkirt: 8 });
  assert.equal(patch.stats.columns, soloColumns, 'merging must not add or drop columns');
  // With neighbours known, a border wall only appears where the neighbour really is lower, so the
  // patch emits fewer walls than nine isolated chunks whose borders are all unknown.
  assert.ok(patch.stats.walls < soloWalls,
    `patch walls ${patch.stats.walls} should be fewer than ${soloWalls} unknown-border walls`);
  assert.equal(patch.stats.noSprite, 0, 'every surface state should find a sprite');
  assert.equal(patch.stream.count, (patch.stats.columns + patch.stats.walls) * 6);
});

test('shell mesh: an empty column costs nothing', () => {
  const empty = {
    cx: 0, cz: 0,
    height: new Uint16Array(SHELL_COLS).fill(HEIGHT_BIAS + (-64)),
    state: new Uint16Array(SHELL_COLS),
  };
  const r = meshShell(assets, empty);
  assert.equal(r.stats.columns, 0);
  assert.equal(r.stream.count, 0);
});

test('shell mesh: decimating keeps the tallest column and seals the seam', () => {
  // Borrow a state that really is a cube, then hand-build a two-chunk step.
  const stateId = svc.shellBytes('minecraft:overworld', 3, 3) &&
    openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state.find((v) => v && cls.cube[v - 1] === 1);
  assert.ok(stateId, 'need a cube state to build shells with');

  const mk = (cx, tallFrom) => {
    const height = new Uint16Array(256);
    const state = new Uint16Array(256).fill(stateId);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) height[(z << 4) | x] = HEIGHT_BIAS + (x >= tallFrom ? 104 : 100);
    }
    return { cx, cz: 0, height, state };
  };
  const cells = new Map([[0, mk(0, 8)], [1, mk(1, 0)]]);   // chunk 0 steps at x=8, chunk 1 is all tall
  const get = (cx, cz) => (cz === 0 ? cells.get(cx) ?? null : null);

  const fine = meshShellPatch(assets, get, 0, 0, 2, 1, { maxSkirt: 0 });
  const coarse = meshShellPatch(assets, get, 0, 0, 2, 1, { cell: 4, maxSkirt: 0 });
  assert.equal(coarse.stats.columns, 32, '32 4x4 cells across two chunks');
  assert.ok(fine.stream.count > coarse.stream.count * 4, 'cell 4 must cost far less than cell 1');

  const ys = (s) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < s.count * 3; i += 3) { lo = Math.min(lo, s.position[i]); hi = Math.max(hi, s.position[i]); }
    return [lo, hi];
  };
  // top faces sit on the block's upper surface: low ground 100 -> y 101, tall ground 104 -> y 105
  assert.deepEqual(ys(coarse.stream), [101, 105], 'cell height must be the tallest column, not an average');

  // The seam where the tall ground meets the low ground: one wall per 4-block cell, reaching down
  // to the low cell's own top face, so no light gap can appear at the join.
  const st = coarse.stream;
  const walls = [];
  for (let q = 0; q < st.count; q += 6) {          // two triangles per quad
    let yLo = Infinity, yHi = -Infinity;
    for (let v = q; v < q + 6; v++) {
      const y = st.position[v * 3 + 1];
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
    }
    if (yHi > yLo) walls.push([st.position[q * 3], yLo, yHi]);
  }
  const step = walls.filter((w) => w[2] - w[1] === 4);
  assert.equal(step.length, 4, 'one 4-block wall per tall cell on the join');
  assert.ok(step.every((w) => w[0] === 8 && w[1] === 101),
    `step walls must sit on the join and stop at the low ground, got ${JSON.stringify(step)}`);
  assert.equal(walls.length, 4, 'unknown patch borders must not leak walls when maxSkirt is 0');
});

test('shell mesh: the detail pass takes over a chunk without opening a hole', () => {
  const stateId = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state
    .find((v) => v && cls.cube[v - 1] === 1);
  assert.ok(stateId, 'need a cube state to build shells with');
  const mk = (cx) => ({
    cx, cz: 0,
    height: new Uint16Array(256).fill(HEIGHT_BIAS + 100),
    state: new Uint16Array(256).fill(stateId),
  });
  const cells = new Map([[0, mk(0)], [1, mk(1)]]);
  const get = (cx, cz) => (cz === 0 ? cells.get(cx) ?? null : null);

  const flat = (s, comp) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = comp; i < s.count * 3; i += 3) { lo = Math.min(lo, s.position[i]); hi = Math.max(hi, s.position[i]); }
    return [lo, hi];
  };
  const full = meshShellPatch(assets, get, 0, 0, 2, 1, { maxSkirt: 0 });
  const cut = meshShellPatch(assets, get, 0, 0, 2, 1, { maxSkirt: 0, skip: (cx) => cx === 1 });
  assert.equal(full.stats.columns, 512);
  assert.equal(cut.stats.columns, 256, 'a taken-over chunk emits no columns');
  assert.deepEqual(flat(cut.stream, 0), [0, 16], 'nothing may be emitted above the detail chunk');
  // The skipped shell still answers neighbour height lookups, so the handover border stays sealed:
  // flat ground on both sides must produce top faces only, at exactly one height.
  assert.deepEqual(flat(cut.stream, 1), [101, 101], 'no skirt may open where the detail pass takes over');

  // Winding: the skin is drawn single-sided, so every emitted face has to face outward. The rings are
  // shared with the detail mesher, and getting one order wrong would silently delete those walls.
  const one = meshShellPatch(assets, get, 0, 0, 1, 1, { maxSkirt: 4 });
  const nrm = new Map();
  for (let q = 0; q < one.stream.count; q += 6) {
    const n = quadNormal(one.stream.position.subarray(q * 3, q * 3 + 9));
    const m = Math.max(...n.map(Math.abs));          // quadNormal is unnormalised: length is the area
    const k = n.map((v) => Math.round(v / m)).join(',');
    nrm.set(k, (nrm.get(k) ?? 0) + 1);
  }
  // one top per column, and one 4-block skirt quad for each of the 16 columns on each patch border.
  // The east border is sealed by the known neighbour shell at the same height, so it gets no wall.
  assert.deepEqual([...nrm.entries()].sort(), [
    ['0,1,0', 256], ['0,0,-1', 16], ['0,0,1', 16], ['-1,0,0', 16],
  ].sort(), 'every face must point outward, and nothing may face down into flat ground');
});

// The far skin carries no sprites: each column is painted with its sprite's mean colour, which is what
// a couple-pixel-wide column averages to anyway, and which does not shatter into mip noise.
test('shell mesh: each face is painted with the mean colour of its sprite', () => {
  const get = (cx, cz) => {
    const b = svc.shellBytes('minecraft:overworld', cx, cz);
    return b ? openShellFrame(ab(b)) : null;
  };
  const shell = get(3, 3);
  const one = meshShell(assets, shell, { nb: get, cell: 1 });
  const s = one.stream;
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const FACE_UP = 1;

  let checked = 0;
  for (let q = 0; q < s.count; q += 6) {
    const v = (i) => [s.position[i * 3], s.position[i * 3 + 1], s.position[i * 3 + 2]];
    const p0 = v(q), p1 = v(q + 1), p2 = v(q + 2);
    const n = quadNormal([].concat(p0, p1, p2, v(q + 3)));
    const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2)
      : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
    if (ax !== 1 || n[1] <= 0) continue;            // top faces only; cell 1 keeps the mapping exact
    const wx = Math.min(p0[0], p1[0], p2[0]);
    const wz = Math.min(p0[2], p1[2], p2[2]);
    const id = shell.state[(((wz & 15) << 4) | (wx & 15))];
    const state = assets.states[id - 1];
    if (!state) continue;
    // The mesher's own "which sprite paints face f" answer, so this test measures the colour path and
    // not a second copy of the sprite lookup.
    const cell = faceSprites(assets, id, new Map())[FACE_UP]?.cell;
    if (!cell || cell.kind === 3) continue;
    const tint = state.ti && cell.g ? tintOf(state) : [1, 1, 1];
    // FACE_SHADE[up] is 1.0 and there is no AO on the shell, so the expected colour is exact.
    for (let k = 0; k < 3; k++) {
      const want = Math.round(lin(cell.c[k] / 255) * tint[k] * 255);
      const got = s.color[q * 4 + k];
      assert.ok(Math.abs(got - want) <= 1, `column ${wx},${wz} channel ${k}: got ${got}, expected ${want} from sprite ${cell.id}`);
    }
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} top faces checked`);
});

// LOD makes neighbouring chunks disagree about cell size, which is exactly where a skin tears: the
// wall between a 1x1 column and an 8x8 block has to be drawn once, by the high side, and reach all
// the way down to the low side's own top face.
test('shell mesh: two different cell sizes on either side of a border still seal it', () => {
  const stateId = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3))).state.find((v) => v && cls.cube[v - 1] === 1);
  assert.ok(stateId, 'need a cube state to build shells with');
  const mk = (cx, h) => (cx === 0 || cx === 1 ? {
    cx, cz: 0,
    height: Uint16Array.from(Array.from({ length: 256 }, (_, k) => HEIGHT_BIAS + (typeof h === 'function' ? h(k & 15, k >> 4) : h))),
    state: new Uint16Array(256).fill(stateId),
  } : null);
  // Every wall quad, as [plane x, y low, y high, z low]. Vertical quads only.
  const wallsOf = (st) => {
    const out = [];
    for (let q = 0; q < st.count; q += 6) {
      let yLo = Infinity, yHi = -Infinity, xLo = Infinity, zLo = Infinity;
      for (let v = q; v < q + 6; v++) {
        const x = st.position[v * 3], y = st.position[v * 3 + 1], z = st.position[v * 3 + 2];
        yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
        xLo = Math.min(xLo, x); zLo = Math.min(zLo, z);
      }
      if (yHi > yLo) out.push([xLo, yLo, yHi, zLo]);
    }
    return out;
  };
  const noDuplicates = (ws, what) => {
    const seen = new Set();
    for (const [x, , , z] of ws) {
      const k = `${x},${z}`;
      assert.ok(!seen.has(k), `${what}: two walls at the same place (${k}) would z-fight`);
      seen.add(k);
    }
  };

  // Fine on the high side: chunk 0 keeps 1x1 columns and steps down to a coarse, low chunk 1.
  const a = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 0 ? ((x) => (x >= 8 ? 104 : 100)) : 100) : null),
    0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 1 : 4) });
  const wa = wallsOf(a.stream);
  assert.equal(wa.length, 32, '16 walls at the internal step plus 16 across the chunk border');
  assert.equal(wa.filter((w) => w[0] === 16).length, 16, 'one wall per fine column across the border');
  assert.ok(wa.every((w) => w[1] === 101 && w[2] === 105), 'walls run from the low top face up to the high one');
  noDuplicates(wa, 'fine high side');

  // Coarse on the high side: one 4x4 cell drops onto a run of fine low columns.
  const b = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 0 ? 104 : 100) : null),
    0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 4 : 1) });
  const wb = wallsOf(b.stream);
  assert.equal(wb.length, 4, 'the coarse side draws one wall per cell, and the fine low side draws none');
  assert.ok(wb.every((w) => w[0] === 16 && w[1] === 101 && w[2] === 105),
    `the coarse wall must cover the whole drop: ${JSON.stringify(wb)}`);
  assert.equal(b.stats.columns, 16 + 256, 'each chunk keeps its own cell size');

  // The drop runs the other way too: coarse and low, fine and tall.
  const c = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 1 ? 104 : 100) : null),
    0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 4 : 1) });
  const wc = wallsOf(c.stream);
  assert.equal(wc.length, 16, 'the 16 fine tall columns each close their own strip');
  assert.ok(wc.every((w) => w[0] === 16 && w[1] === 101 && w[2] === 105),
    `no light gap at a coarse-to-fine border: ${JSON.stringify(wc)}`);
  noDuplicates(wc, 'coarse low side');
});

// A decimated cell that copies one sprite makes the far view sparkle: one bright ore cube speaks for
// sixteen blocks. The cell has to lean on the colours around it - but only on columns at its own
// height, or a treetop would come out the colour of the dirt under it.
test('shell mesh: a decimated cell paints its quantile column and borrows colour only from its own height band', () => {
  // A coarse cell paints one column and shades it from the other columns in the cell. Two rules
  // keep that from smearing the map: it borrows only from columns within `cell` blocks of the
  // painted height, so a coarse-stone cell beside a 40-block forest does not come back half green;
  // and the blend stays a minority of the colour, so the sprite is still recognisable.
  const idFor = (k) => {
    const i = assets.json.states.findIndex((s) => s.k === k);
    if (i < 0) throw new Error(`the atlas has no ${k}`);
    return i + 1;
  };
  const CELL = 4;
  const mk = (mode) => {
    const height = new Uint16Array(256).fill(HEIGHT_BIAS + 100);
    const state = new Uint16Array(256).fill(idD);
    const cell0 = [];
    for (let k = 0; k < 256; k++) if (((k >> 4) & 15) < CELL && (k & 15) < CELL) cell0.push(k);
    for (const k of cell0) height[k] = HEIGHT_BIAS + 101;   // all level, so the cell owns one height
    cell0.forEach((k, n) => { state[k] = n > 0 && n <= 8 ? idB : idD; });
    if (mode === 'sunk') for (let n = 1; n <= 8; n++) height[cell0[n]] = HEIGHT_BIAS + 90;
    return { height, state };
  };
  const run = (mode = '') => {
    const sh = { cx: 0, cz: 0, ...mk(mode) };
    const get = (cx, cz) => (cx === 0 && cz === 0 ? sh : null);
    const { stream: st } = meshShellPatch(assets, get, 0, 0, 1, 1,
      { cell: CELL, maxSkirt: 8, blend: mode === 'off' ? 0 : undefined, trackStates: true });
    // The top quad of cell (0,0): four corners at the cell height, spanning exactly cell x cell.
    for (let q = 0; q < st.count; q += 6) {
      const V = (i) => [st.position[i * 3], st.position[i * 3 + 1], st.position[i * 3 + 2]];
      const p = [V(q), V(q + 1), V(q + 2), V(q + 3)];
      if (!p.every((v) => v[1] === 102)) continue;  // top block 101 -> surface 102
      const xs = p.map((v) => v[0]), zs = p.map((v) => v[2]);
      if (Math.min(...xs) !== 0 || Math.min(...zs) !== 0) continue;
      if (Math.max(...xs) !== CELL || Math.max(...zs) !== CELL) continue;
      return [st.color[q * 4], st.color[q * 4 + 1], st.color[q * 4 + 2]];
    }
    throw new Error('no top quad painted for cell (0,0)');
  };
  const lum = (q) => (q[0] * 299 + q[1] * 587 + q[2] * 114) / 1000;
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  // The same colour the mesher paints a top face with: its sprite mean, tinted, in linear light.
  const pure = (id) => {
    const cell = faceSprites(assets, id, new Map())[1]?.cell;
    if (!cell) throw new Error(`state ${id} paints no top face`);
    const t = assets.states[id - 1].ti && cell.g ? tintOf(assets.states[id - 1]) : [1, 1, 1];
    return [0, 1, 2].map((k) => lin(cell.c[k] / 255) * t[k] * 255);
  };
  // Bright: grass. Dark: the darkest-topped cube state in the atlas. Both must be cubes, or the
  // skin would not paint them at all.
  const idB = idFor('minecraft:grass_block|snowy=false');
  let idD = 0, pD = null;
  for (let id = 1; id <= assets.states.length; id++) {
    if (cls.cube[id - 1] !== 1 || !assets.states[id - 1].g?.length) continue;
    let c; try { c = pure(id); } catch { continue; }
    const L = lum(c);
    if (pD === null || L < lum(pD)) { pD = c; idD = id; }
  }
  assert.ok(idD && idD !== idB, 'need a dark cube state to blend against');
  const pB = pure(idB);
  const span = lum(pB) - lum(pD);
  assert.ok(Math.abs(span) > 40,
    `synthetic states need a wide luminance span to test a blend: bright ${pB} dark ${pD}`);
  // The cell paints its column 0 (dark) and blends over the 15 others, 8 of which are bright.
  const w = blendFor(CELL) * 15 / 16;
  const mean = pD.map((_, k) => (8 * pB[k] + 7 * pD[k]) / 15);
  const want = pD.map((v, k) => v * (1 - w) + mean[k] * w);
  const cBase = run();
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(cBase[k] - want[k]) <= 1.5,
      `the blend must be the in-band mean at the blend weight: got ${cBase}, wanted ${want}`);
  }
  assert.ok(Math.abs(lum(cBase) - lum(pD)) > span * 0.15,
    `the blend must move the colour off the painted sprite: ${cBase} vs pure ${pD}`);
  assert.ok(Math.abs(lum(cBase) - lum(pB)) > span * 0.5,
    `but it must not repaint the cell with its neighbours: ${cBase} vs pure ${pB}`);
  // Those same eight bright blocks, four levels down, are outside the band and must not tint at all.
  const sunk = run('sunk');
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(sunk[k] - pD[k]) <= 1,
      `a column four blocks down is outside the band, so it cannot tint the cell: ${sunk} vs pure ${pD}`);
  }
  assert.ok(lum(run('off')) < lum(pD) + 1, 'blend 0 must reproduce the painted sprite exactly');
});

// A flower or a head of tall grass is visible from far away, but it has no box to paint a coarse cell
// with. The skin keeps the column's height and paints a cube found within a bounded drop, so plants
// show as the ground they stand in rather than as holes.
test('shell: a plant column still picks a paintable cube state', () => {
  let plants = 0, painted = 0, holes = 0, worstDrop = 0;
  for (const [cx, cz] of [[3, 3], [4, 3], [5, 4], [-2, 6]]) {
    const raw = svc.chunkBytes('minecraft:overworld', cx, cz);
    if (!raw) continue;
    const c = openChunk(raw);
    const s = openShellFrame(ab(svc.shellBytes('minecraft:overworld', cx, cz)));
    for (let k = 0; k < SHELL_COLS; k++) {
      const x = k & 15, z = k >> 4;
      const top = s.height[k] - HEIGHT_BIAS;
      const surf = c.stateAt(x, top, z);
      if (!surf || cls.cube[surf - 1] === 1) continue;        // a cube column is trivially paintable
      plants++;
      const id = s.state[k];
      if (!id) { holes++; continue; }
      if (cls.cube[id - 1] !== 1) continue;                   // the paint choice has to be a cube
      painted++;
      let drop = -1;
      for (let y = top; y >= top - 8 && drop < 0; y--) if (cls.cube[c.stateAt(x, y, z) - 1] === 1) drop = top - y;
      if (drop < 0) continue;
      worstDrop = Math.max(worstDrop, drop);
    }
  }
  assert.ok(plants > 20, `only ${plants} non-cube surface columns in the sample`);
  assert.equal(holes, 0, 'a plant column must not leave a hole in the skin');
  assert.ok(painted >= plants * 0.9, `only ${painted}/${plants} plant columns found a cube to paint`);
  assert.ok(worstDrop <= 8, `the painted cube sat ${worstDrop} blocks under the visible surface`);
});

test('shell mesh: a tracked stream names the block that painted each quad', () => {
  const shell = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3)));
  const CELL = 2;
  const { stream } = meshShell(assets, shell, { cell: CELL, maxSkirt: 0, trackStates: true });
  assert.ok(stream.stateIds, 'trackStates must record a state per quad');
  assert.equal(stream.stateIds.length, stream.count / 6, 'exactly one id per quad');
  assert.equal(meshShell(assets, shell, { cell: CELL, maxSkirt: 0 }).stream.stateIds, undefined,
    'an untracked mesh pays nothing');

  const inChunk = new Set(shell.state.filter((v) => v));
  const P = stream.position;
  let tops = 0;
  for (let q = 0; q < stream.count; q += 6) {
    const id = stream.stateIds[q / 6];
    assert.ok(inChunk.has(id), `quad at vertex ${q} claims state ${id}, which is not in this chunk`);
    // A flat horizontal quad is a cell top: its corners straddle the cell, so its minimum corner
    // says which cell it is, and the cell's tallest column is what painted it.
    let wx = Infinity, wz = Infinity, yLo = Infinity, yHi = -Infinity;
    for (let v = 0; v < 6; v++) {
      const o = (q + v) * 3;
      wx = Math.min(wx, P[o]); wz = Math.min(wz, P[o + 2]);
      yLo = Math.min(yLo, P[o + 1]); yHi = Math.max(yHi, P[o + 1]);
    }
    if (yHi !== yLo) continue;
    tops++;
    // corners are exact integers, so the minimum corner is the cell's own origin
    const x0 = Math.floor((wx - shell.cx * 16) / CELL) * CELL;
    const z0 = Math.floor((wz - shell.cz * 16) / CELL) * CELL;
    let bestH = -1, bestI = 0;
    for (let j = 0; j < CELL; j++) {
      for (let i = 0; i < CELL; i++) {
        const k = ((z0 + j) << 4) + (x0 + i);
        if (shell.height[k] > bestH) { bestH = shell.height[k]; bestI = k; }
      }
    }
    assert.equal(id, shell.state[bestI],
      `top quad at ${wx},${wz} painted from ${id} but the tallest column of that cell is ${shell.state[bestI]}`);
  }
  assert.equal(tops, (16 / CELL) ** 2, 'every cell must emit exactly one top with maxSkirt 0');
});

// The shell used to dig under any surface it did not recognise as a block and paint the column with
// the dirt underneath, which turned a grass map brown. The block standing at the surface is what the
// eye is being asked to recognise, so it must survive the trip into the shell frame.
test('shell: a column is painted with the block that is actually at the surface', () => {
  const sh = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 3, 3)));
  const c = openChunk(svc.chunkBytes('minecraft:overworld', 3, 3));
  let same = 0, replaced = 0, notBlock = 0, deep = 0;
  for (let i = 0; i < 256; i++) {
    const x = i & 15, z = i >> 4, y = c.surfaceAt(x, z);
    const top = c.stateAt(x, y, z);
    if (!top) continue;
    if (sh.state[i] === top) { same++; continue; }
    replaced++;
    // Whatever it settled on has to be a block (that is the whole point of the far pass), and it has
    // to be the block the surface is standing on, not something further down the column.
    if (cls.cube[sh.state[i] - 1] !== 1) notBlock++;
    let depth = -1;
    for (let k = 0; k <= 4; k++) if (c.stateAt(x, y - k, z) === sh.state[i]) { depth = k; break; }
    if (depth > 1) deep++;
  }
  console.log(`shell columns: surface ${same}/256, painted with the block under it ${replaced}`);
  assert.ok(same > 180, `only ${same}/256 columns keep their own surface block`);
  assert.equal(notBlock, 0, 'a shell column must be painted with a block, never a plant');
  assert.ok(deep <= 2, `${deep} columns reached past the block underneath the surface`);
});

// A quad-path state stores its sprite in the packed flags word next to the geometry index. Read the
// wrong word and every face of a modded block quietly gets some other block's colour.
test('shell sprites: a block that paints its own sides picks the right sprite per face', () => {
  const id = assets.indexOf('minecraft:grass_block|snowy=false') + 1;
  assert.ok(id > 0, 'grass_block must be in the atlas table');
  const per = faceSprites(assets, id, new Map());
  assert.equal(per[1].cell.id, 'minecraft:block/grass_block_top', 'the top of a grass block is grass');
  assert.equal(per[4].cell.id, 'minecraft:block/grass_block_side', 'its side is the side sprite');
  assert.equal(cls.cube[id - 1], 1, 'and the far pass still knows it is a full block');
});
