// What a far column is allowed to be painted with, and how tall the cell that paints it stands (M5.8).
// The shell used to answer one question per column - "the tallest full cube" - which made a lake a blue
// sheet, a flowerbed a dirt plain, and a forest a set of floating dirt plates. It now answers four:
// the surface the eye sees, what sits at it, the top of the solid ground, and the block that may paint
// the cell. These tests pin that split with synthetic columns, so the arithmetic is exact instead of
// "most of chunk 3,3 agrees".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WorldService } from '../server/world-service.mjs';
import { shellFromPayload } from '../server/shell.mjs';
import { buildStateIds, packChunk, openChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS, SHELL_HEADER, SHELL_COLS, SHELL_COLS_BYTES, SHELL_LIGHT_BYTES, SHELL_BAND_BYTES }
  from '../shared/chunk-format.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// The policy worldd runs with: paint must be solid *and* opaque, support only has to be solid.
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const isSolid = (id) => cls.cube[id - 1] === 1;
const svc = new WorldService('DarkRPG/world', buildStateIds(atlas.states.map((s) => s.k)), null, {
  isPaintState: isPaint, isSolidState: isSolid,
});
const idOf = (k) => {
  const i = atlas.states.findIndex((s) => s.k === k);
  assert.ok(i >= 0, `the atlas has no ${k}`);
  return i + 1;
};
const ID = {
  gravel: idOf('minecraft:gravel'),
  grass: idOf('minecraft:grass_block|snowy=false'),
  water: idOf('minecraft:water|level=0'),
  tuft: idOf('minecraft:tall_grass|half=lower'),
  leaves: idOf('minecraft:spruce_leaves|distance=1,persistent=false,waterlogged=false'),
  log: idOf('minecraft:oak_log|axis=y'),
};
const nm = (id) => (id ? (atlas.states[id - 1]?.k ?? `?${id}`) : 'none');

/** One synthetic chunk, wide enough in Y for a deep lake, with five columns that each ask something. */
function lakeChunk() {
  const yMin = 3, yCount = 3;                     // sections 3..5 => world y 48..95
  const pal = [0, ID.gravel, ID.grass, ID.water, ID.tuft, ID.leaves];
  const slot = (id) => pal.indexOf(id);
  const sects = new Map();
  const put = (x, y, z, id) => {
    const sy = y >> 4;
    assert.ok(sy >= yMin && sy < yMin + yCount, `y ${y} outside the synthetic chunk`);
    let vox = sects.get(sy);
    if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
    vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = slot(id);
  };
  const stack = (x, z, from, to, id) => { for (let y = from; y <= to; y++) put(x, y, z, id); };
  stack(0, 0, 50, 59, ID.gravel); stack(0, 0, 60, 63, ID.water);   // (0,0) deep lake
  put(1, 63, 0, ID.grass); put(1, 64, 0, ID.water);                // (1,0) one block puddle
  put(2, 63, 0, ID.grass); put(2, 64, 0, ID.tuft);                 // (2,0) grass tuft
  put(3, 63, 0, ID.grass); stack(3, 0, 64, 67, ID.leaves);         // (3,0) spruce canopy
  stack(4, 0, 56, 63, ID.water);                                   // (4,0) water, nothing under it

  const height = new Uint16Array(256);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let top = 0;
      for (let y = (yMin + yCount) * 16 - 1; y >= yMin * 16; y--) {
        const vox = sects.get(y >> 4);
        if (vox && vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]) { top = y; break; }
      }
      height[(z << 4) | x] = top ? top + HEIGHT_BIAS : 0;
    }
  }
  return packChunk({
    cx: 0, cz: 0, yMin, yCount, palette: pal,
    sections: [...sects.entries()].sort((a, b) => a[0] - b[0]).map(([y, vox]) => ({ y, single: 0, vox })),
    height, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: false,
  });
}

test('shell: a lake keeps its water line but paints its bed', () => {
  const s = openShellFrame(ab(shellFromPayload(lakeChunk(), { isPaint, isSolid })));
  const at = (x, z) => ({
    surf: s.surfaceAt(x, z), ground: s.groundAt(x, z),
    cover: nm(s.coverAt(x, z)), paint: nm(s.stateAt(x, z)),
  });

  // Deep lake: the eye still sees water at y63, but the cell is painted gravel and knows the bed sits
  // at 59. That is what lets the mesh hold the lake up at the water line without making it solid blue.
  assert.deepEqual(at(0, 0), { surf: 63, ground: 59, cover: nm(ID.water), paint: 'minecraft:gravel' });
  // One block of water: the bed is one step down, so a far view can still see through it.
  assert.deepEqual(at(1, 0), { surf: 64, ground: 63, cover: nm(ID.water), paint: nm(ID.grass) });
  // A plant is neither a floor nor a surface you see through: recorded as cover, cell stands on ground.
  assert.deepEqual(at(2, 0), { surf: 64, ground: 63, cover: nm(ID.tuft), paint: nm(ID.grass) });
  // Leaves are a full cube you can see through: the canopy stays the surface, the ground is under it.
  assert.deepEqual(at(3, 0), { surf: 67, ground: 63, cover: nm(ID.leaves), paint: nm(ID.grass) });
  // Nothing paintable within the drop budget: fall back to painting the cover, the old behaviour, and
  // better than an empty cell.
  assert.deepEqual(at(4, 0), { surf: 63, ground: 63, cover: nm(ID.water), paint: nm(ID.water) });
});

/**
 * A tall tree and a player's wall, so the two questions the paint rule must separate sit side by side:
 * a 20-block trunk is a *spike* standing on a forest floor, while a wall the player built out of the
 * same log is the surface itself.
 */
function forestChunk() {
  const yMin = 3, yCount = 3;
  const pal = [0, ID.grass, ID.log, ID.leaves];
  const sects = new Map();
  const put = (x, y, z, id) => {
    const sy = y >> 4;
    let vox = sects.get(sy);
    if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
    vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = pal.indexOf(id);
  };
  const stack = (x, z, from, to, id) => { for (let y = from; y <= to; y++) put(x, y, z, id); };
  for (let z = 0; z <= 4; z++) for (let x = 8; x <= 15; x++) put(x, 63, z, ID.grass);   // forest floor
  stack(12, 0, 64, 84, ID.log);                        // trunk, 21 blocks tall
  for (let z = 0; z <= 2; z++) for (let x = 11; x <= 13; x++) stack(x, z, 85, 88, ID.leaves);
  for (let x = 9; x <= 11; x++) stack(x, 3, 64, 66, ID.log);   // a player's 1-block-thick log wall
  stack(15, 4, 64, 68, ID.log);                        // and a 1x1 pillar nobody can see from far off

  const height = new Uint16Array(256);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let top = 0;
      for (let y = (yMin + yCount) * 16 - 1; y >= yMin * 16; y--) {
        const vox = sects.get(y >> 4);
        if (vox && vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]) { top = y; break; }
      }
      height[(z << 4) | x] = top ? top + HEIGHT_BIAS : 0;
    }
  }
  return packChunk({
    cx: 0, cz: 0, yMin, yCount, palette: pal,
    sections: [...sects.entries()].sort((a, b) => a[0] - b[0]).map(([y, vox]) => ({ y, single: 0, vox })),
    height, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: false,
  });
}

test('shell: a tall tree stands on its forest floor, and a log wall stays a wall', () => {
  const s = openShellFrame(ab(shellFromPayload(forestChunk(), { isPaint, isSolid })));
  const at = (x, z) => ({
    surf: s.surfaceAt(x, z), ground: s.groundAt(x, z),
    cover: nm(s.coverAt(x, z)), paint: nm(s.stateAt(x, z)),
  });
  // The trunk is a full opaque cube, so "is it paintable?" says yes - and using it as the ground is what
  // made a far cell a 21-block solid column: the tree that reads as a tower. Structurally it is a spike,
  // not a surface: nothing paintable sits next to it at its own level. The cell therefore stands on the
  // forest floor, but it is still painted with the bark, which is the right material for a trunk wall.
  assert.deepEqual(at(12, 0), { surf: 88, ground: 63, cover: nm(ID.leaves), paint: nm(ID.log) },
    'a canopy 25 blocks up finds the floor under the trunk, not the trunk top');
  // The same log laid in a row IS a surface, and the far view must keep painting the player's wall.
  assert.deepEqual(at(10, 3), { surf: 66, ground: 66, cover: nm(ID.log), paint: nm(ID.log) },
    'a 1-block-thick wall keeps its own height and its own material');
  // A lone 1x1 pillar is the honest limit of this rule: its top block is itself paintable, so the far
  // view reads it as a surface. Fixing that would mean the same question one level up, and it is not
  // what the user is complaining about - a real tree always has a canopy, which is never paintable.
  assert.equal(at(15, 4).ground, 68, 'a paintable spike keeps its height (documented limit)');
  // Ordinary ground is untouched by all of this.
  assert.deepEqual(at(9, 1), { surf: 63, ground: 63, cover: nm(ID.grass), paint: nm(ID.grass) });
});

test('shell: a frame carries four planes and two bytes, and a reader rejects a nonsense size', () => {
  const chunk = lakeChunk();
  const raw = shellFromPayload(chunk, { isPaint, isSolid });
  const s = openShellFrame(ab(raw));
  for (const plane of ['height', 'cover', 'ground', 'state']) {
    assert.equal(s[plane].length, 256, `${plane} plane`);
  }
  // height is the only plane copied straight from WORLD_SURFACE; the others are decisions about it.
  const c = openChunk(chunk);
  for (let i = 0; i < 256; i++) assert.equal(s.height[i], c.height[i], `column ${i}`);
  // ground never sits above the surface, and a cell is only painted with its cover when there is
  // nothing else to paint it with.
  for (let i = 0; i < 256; i++) {
    assert.ok(s.ground[i] <= s.height[i], `ground ${s.ground[i]} above surface ${s.height[i]}`);
    if (s.cover[i] && s.cover[i] === s.state[i]) {
      assert.equal(s.ground[i], s.height[i], `column ${i}: painted with its cover but the ground is lower`);
    }
  }
  // Four u16 planes plus a light byte and a skin byte. A frame of any other length is a different
  // format, and silently reading one would paint the ground plane as the paint plane.
  assert.equal(raw.length, SHELL_HEADER + SHELL_COLS * SHELL_COLS_BYTES + SHELL_LIGHT_BYTES + SHELL_BAND_BYTES,
    'four u16 planes plus a light byte and a skin byte per column');
  assert.throws(() => openShellFrame(ab(raw.subarray(0, SHELL_HEADER + SHELL_COLS * 6))), /too short/);
  // The pre-skin frame (v3) is still readable, with no skin anywhere: a pack that has not been
  // re-baked yet is a flat far view, not a crash and not a tower.
  const v3 = Buffer.from(raw);
  v3.writeUInt16LE(3, 8);
  const old = openShellFrame(ab(v3.subarray(0, SHELL_HEADER + SHELL_COLS * (2 * 4 + 1))));
  assert.equal(old.band.length, 256);
  assert.ok(old.band.every((b) => b === 0), 'a frame without the byte has no skin to draw');
});

test('shell: the real lake at 2976,2007 is painted with its bed, not its skin', () => {
  const real = openShellFrame(ab(svc.shellBytes('minecraft:overworld', 186, 125)));
  assert.equal(real.surfaceAt(7, 15), 62, 'lake surface');
  assert.equal(real.coverAt(7, 15), ID.water, 'the cover is the water skin');
  assert.ok(real.stateAt(7, 15) !== ID.water, 'a far lake is not painted with water');
  assert.equal(cls.opaque[real.stateAt(7, 15) - 1], 1, 'and it is painted with something opaque');
  assert.ok(real.groundAt(7, 15) < real.surfaceAt(7, 15) - 20, 'the bed is some way below the water line');
});

test('shell mesh: a coarse cell stands on its ground, not on the cover above it', () => {
  const mk = (coverId) => {
    const sh = {
      cx: 0, cz: 0,
      height: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
      ground: new Uint16Array(256).fill(80 + HEIGHT_BIAS),
      cover: new Uint16Array(256).fill(coverId),
      state: new Uint16Array(256).fill(ID.gravel),
    };
    return (cx, cz) => (cx === 0 && cz === 0 ? sh : null);
  };
  const topOf = (get, opts) => {
    const { stream } = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 8, ...opts });
    const p = stream.position;
    let top = -1e9;
    for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
    return top;
  };
  // A plant (not a cube, not see-through) is not a floor: the cell drops to the ground it stands on.
  assert.equal(topOf(mk(ID.tuft), {}), 81, 'a plant column stands on the ground');
  assert.equal(topOf(mk(ID.tuft), { groundFar: 0 }), 101, 'groundFar 0 keeps the old WORLD_SURFACE top');
  // Leaves fill the column, so their top is a real silhouette at one block per cell. Past that, the
  // old exception stood a 16-block-wide column on the treetops, which is what made a forest read as a
  // pile of solid towers: at a coarse cell the body is the ground and the canopy survives as colour.
  assert.equal(topOf(mk(ID.leaves), {}), 81, 'a coarse cell stands on its ground, not on its canopy');
  assert.equal(topOf(mk(ID.leaves), { cell: 1 }), 101, 'at one block per cell the canopy keeps its top');
  // Water is a full cube too, but it is a plane the eye sees through: it is the surface at any cell
  // size, or the cell collapses onto the bed and punches a hole in the world.
  assert.equal(topOf(mk(ID.water), {}), 101, 'a lake keeps its water line even at a coarse cell');
  // A frame with no ground plane (an older bake) keeps the surface instead of collapsing to 0.
  const v1 = mk(ID.tuft);
  const get1 = (cx, cz) => {
    const s = v1(cx, cz);
    return s ? { ...s, ground: null, cover: null } : null;
  };
  assert.equal(topOf(get1, {}), 101, 'no ground plane, no decision: keep the surface');
});

test('shell mesh: one water surface at any depth, because the detail pass culls water-to-water', () => {
  const mk = (depth, coverId, paintId) => (cx, cz) => (cx === 0 && cz === 0
    ? {
        cx: 0, cz: 0,
        height: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        ground: new Uint16Array(256).fill(100 - depth + HEIGHT_BIAS),
        cover: new Uint16Array(256).fill(coverId),
        state: new Uint16Array(256).fill(paintId),
      }
    : null);
  const colOf = (get) => {
    const { stream } = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 2, maxSkirt: 0 });
    return [stream.color[0], stream.color[1], stream.color[2]];
  };
  const bed = colOf(mk(0, 0, ID.gravel));
  const water = colOf(mk(0, ID.water, ID.water));
  const shallow = colOf(mk(1, ID.water, ID.gravel));
  const deep = colOf(mk(30, ID.water, ID.gravel));
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(d(bed, water) > 8, `bed ${bed} and water ${water} must differ for this to mean anything`);
  assert.ok(d(shallow, bed) > 0.5, 'the film moves a puddle off the bare bed colour');
  assert.ok(d(shallow, bed) < d(shallow, water), 'a one block puddle still shows the bed');
  // Same single film at 30 m and at 1 m: what differs between them is the bed, not the alpha.
  assert.ok(d(deep, shallow) < 1, `depth must not change the colour: deep ${deep}, puddle ${shallow}`);
  assert.ok(d(deep, bed) < d(deep, water), 'a deep lake still reads as bed plus film, like the detail pass');
});

test('shell mesh: a lake cell is water even when its sample column is a reef', () => {
  // A cell is painted by one representative column, so a 16x16 lake cell whose lucky sample lands on a
  // sandbar used to paint a sand square in the middle of the lake. The cell asks the whole cell instead:
  // is most of it water, and how deep is the deepest part of it.
  const ID_sand = idOf('minecraft:sand');
  const mk = (dryAt) => (cx, cz) => (cx === 0 && cz === 0
    ? {
        cx: 0, cz: 0,
        height: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        ground: new Uint16Array(256).fill(70 + HEIGHT_BIAS),
        cover: new Uint16Array(256).fill(ID.water),
        state: new Uint16Array(256).fill(ID.gravel),
      }
    : null);
  const poke = (get, x, z, ground, cover, state) => (cx, cz) => {
    const s = get(cx, cz);
    if (!s) return null;
    const k = (z << 4) | x;
    s.ground[k] = ground + HEIGHT_BIAS; s.cover[k] = cover; s.state[k] = state;
    return s;
  };
  const colOf = (get) => {
    const { stream } = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 0 });
    return [stream.color[0], stream.color[1], stream.color[2]];
  };
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const dryCell = (cx, cz) => (cx === 0 && cz === 0
    ? {
        cx: 0, cz: 0,
        height: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        ground: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        cover: new Uint16Array(256).fill(0),
        state: new Uint16Array(256).fill(ID_sand),
      }
    : null);
  const allWater = colOf(mk());
  // One dry sandbar, at the column the height tie-break picks first, over the same deep water.
  const reef = poke(mk(), 0, 0, 99, 0, ID_sand);
  const onReef = colOf(reef);
  // Same cell, only one column of water: a puddle on sand, which must stay sand.
  const mostlyDry = (cx, cz) => {
    const s = mk()(cx, cz);
    if (!s) return null;
    for (let i = 0; i < 256; i++) { s.cover[i] = 0; s.state[i] = ID_sand; s.ground[i] = 100 + HEIGHT_BIAS; }
    s.cover[0] = ID.water; s.ground[0] = 99 + HEIGHT_BIAS;
    return s;
  };
  const onSand = colOf(mostlyDry);

  assert.ok(d(onSand, allWater) > 8, `sand ${onSand} and water ${allWater} must differ to mean anything`);
  assert.ok(d(onReef, allWater) < d(onReef, onSand),
    `a reef in a lake should read as water: reef ${onReef}, water ${allWater}, sand ${onSand}`);
  // One wet column in sixteen is not a lake. It still reads as sand: the cell-wide film does not
  // trigger, and only the sample column's own one-block puddle tints it a little.
  const plain = colOf(dryCell);
  assert.ok(d(onSand, plain) < d(onSand, allWater), `a puddle stays sand: ${onSand} vs ${plain}, ${allWater}`);
});


// Two paints, one terrain. The far layer used to be flat plates because a sprite at two pixels per quad
// looked like noise, but a plate is also what made the far side of the detail ring read paler than the
// near side. Texturing fixes the match, provided the vertex colour stops carrying the sprite mean as
// well: the sprite is the colour, so the vertex colour only carries face shade and tint.
test('shell mesh: the textured paint carries shade only, and only real water gets a film', () => {
  const box = (over) => (cx, cz) => (cx === 0 && cz === 0
    ? {
        cx: 0, cz: 0,
        height: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        ground: new Uint16Array(256).fill(100 + HEIGHT_BIAS),
        cover: new Uint16Array(256).fill(0),
        state: new Uint16Array(256).fill(ID.gravel),
        ...over,
      }
    : null);
  const mesh = (get, opts) => meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, maxSkirt: 0, ...opts });
  const lake = {
    height: new Uint16Array(256).fill(110 + HEIGHT_BIAS),
    cover: new Uint16Array(256).fill(ID.water),
  };
  const first = (r) => [r.stream.color[0], r.stream.color[1], r.stream.color[2]];

  const plate = mesh(box(), {});
  const tex = mesh(box(), { tex: true });
  assert.equal(tex.film, undefined, 'texturing adds no extra stream');
  assert.equal(tex.stream.count, plate.stream.count, 'the same terrain either way');
  assert.deepEqual([...tex.stream.position], [...plate.stream.position], 'and in the same places');

  // Gravel takes no tint, so a textured cell is greyscale: an unshaded top face, shaded cliff walls.
  // Relief survives with no sprite mean anywhere in it.
  const shades = (s) => {
    const out = new Set();
    for (let i = 0; i < s.count * 4; i += 4) out.add(s.color[i] + ',' + s.color[i + 1] + ',' + s.color[i + 2]);
    return out;
  };
  const lit = shades(mesh(box(), { tex: true, maxSkirt: 8 }).stream);
  assert.ok(lit.has('255,255,255'), 'an unshaded top face, got ' + [...lit].join(' '));
  assert.ok([...lit].some((c) => { const v = c.split(',').map(Number); return v[0] < 210 && v[0] > 90; }),
    'a shaded cliff face, got ' + [...lit].join(' '));
  assert.ok([...lit].every((c) => c.split(',').every((v) => v === c.split(',')[0])),
    'an untinted block stays greyscale, got ' + [...lit].join(' '));
  // The plate, same terrain, paints the sprite's own average instead: that difference is the seam
  // between the far layer and the detail pass, and why the two used to look differently lit.
  const dull = shades(mesh(box(), { maxSkirt: 8 }).stream);
  assert.ok(!dull.has('255,255,255'), 'a plate never reaches white: ' + [...dull].join(' '));

  // A lake is its bed with a film folded into the colour, in both paints. As real geometry - one
  // translucent quad at the water line, exactly as the detail pass draws it - the film took the far
  // layer over this lake from 3.6 M to 12.0 M verts at 1.5 km, and the water sprite minified across an
  // 8-16 block quad rang in moire from shore to shore. A colour costs nothing and reads the same here.
  const wetTex = mesh(box(lake), { tex: true });
  const wetT = first(wetTex);
  const wetPlate = mesh(box(lake), {});
  assert.deepEqual([...wetTex.stream.position], [...wetPlate.stream.position],
    'a lake draws the same box in either paint');
  assert.deepEqual(first(tex), [255, 255, 255], 'a dry textured cell is unshaded on top');
  assert.ok(wetT[2] - wetT[0] > 20, 'a wet cell comes out bluer than its own bed: ' + wetT);
  const puddle = first(mesh(box({
    height: new Uint16Array(256).fill(101 + HEIGHT_BIAS),
    cover: new Uint16Array(256).fill(ID.water),
  }), { tex: true }));
  assert.ok(Math.max(...puddle.map((v, i) => Math.abs(v - wetT[i]))) <= 1,
    'depth does not change the film, only the bed under it: lake ' + wetT + ' puddle ' + puddle);

  // And a canopy is not a lake. isSeeThrough - a full block whose sprite is not opaque - is true of
  // leaves as well, because a cutout sprite has holes; reading that as a film laid water-tinted sheets
  // over every forest. Only an atlas kind 2 sprite, one you can see through, earns a film.
  // Reading it the other way was also wrong: because leaves are not opaque, the bake refused to paint a
  // column with them, so the far view drew every forest as a field of brown trunks. Shape decides the
  // colour now: a full cube you cannot see through like water *is* the surface.
  const canopy = {
    height: new Uint16Array(256).fill(120 + HEIGHT_BIAS),
    cover: new Uint16Array(256).fill(ID.leaves),
  };
  const leafTex = mesh(box(canopy), { tex: true });
  const leafPlate = mesh(box(canopy), {});
  const leaf = first(leafTex);
  assert.ok(leaf[1] > leaf[2] + 30 && leaf[1] > leaf[0] + 10,
    'a canopy paints its own leaves, green rather than water-blue or the ground under it: ' + leaf);
  const direct = first(mesh(box({ ...canopy, state: new Uint16Array(256).fill(ID.leaves) }), { tex: true }));
  assert.deepEqual([...leaf], [...direct], 'the canopy colour is the leaves sprite, not a blend over its ground');
  assert.deepEqual([...leafTex.stream.position], [...leafPlate.stream.position],
    'a canopy changes the colour of the cell, never its geometry');
  const leafP = first(leafPlate);
  assert.ok(leafP[1] > leafP[0] && leafP[1] > leafP[2], 'the plate paint carries the canopy too: ' + leafP);
  // ... and the trunk still wears bark. A canopy cell hangs walls down to the ground next to it, and
  // painting those leaf-coloured is what made a far forest read as scattered cubes instead of trees.
  const sides = shades(mesh(box(canopy), { tex: true, maxSkirt: 8 }).stream);
  const green = [...sides].filter((c) => { const [r, g, b] = c.split(',').map(Number); return g > r + 12 && g > b + 12; });
  const bark = [...sides].filter((c) => { const [r, g] = c.split(',').map(Number); return g <= r; });
  assert.ok(green.length, 'the canopy roof is leaf-coloured: ' + [...sides].join(' '));
  assert.ok(bark.length, 'the walls under it keep the ground block itself: ' + [...sides].join(' '));
});
