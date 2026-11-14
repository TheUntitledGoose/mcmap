// A canopy has to arrive as a canopy. The far layer used to answer a cell with one height and extrude
// everything under it, which is how a tree became a solid tower: grass on top, a brown wall from the
// forest floor to the treetops. The shell now carries a fifth number per column - how thick the
// see-through skin at the surface is - so a cell can paint its ground *and* draw the skin where the skin
// actually stands. These tests pin that with one synthetic tree, because "the screenshot looks better"
// cannot tell a 5-block canopy wall from a 12-block lie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shellFromPayload } from '../server/shell.mjs';
import { packChunk } from '../server/chunk-payload.mjs';
import { classifyStates } from '../shared/cube-path.mjs';
import { HEIGHT_BIAS } from '../shared/chunk-format.mjs';
import { Assets } from '../web/js/assets.js';
import { openShellFrame } from '../web/js/payload.js';
import { meshShellPatch } from '../web/js/shell-mesh.js';

const atlas = JSON.parse(fs.readFileSync('build/assets/atlas.json', 'utf8'));
const geo = fs.readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geo.buffer.slice(geo.byteOffset, geo.byteOffset + geo.byteLength));
const cls = classifyStates(atlas.states, atlas.textures);
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const isPaint = (id) => cls.cube[id - 1] === 1 && cls.opaque[id - 1] === 1;
const isSolid = (id) => cls.cube[id - 1] === 1;
const isFilm = (id) => cls.film[id - 1] === 1;   // water and ice: they hold a surface up, they are not skin

const idOf = (k) => {
  const i = atlas.states.findIndex((s) => s.k === k);
  assert.ok(i >= 0, `the atlas has no ${k}`);
  return i + 1;
};
const ID = {
  dirt: idOf('minecraft:dirt'),
  grass: idOf('minecraft:grass_block|snowy=false'),
  log: idOf('minecraft:oak_log|axis=y'),
  leaves: idOf('minecraft:spruce_leaves|distance=1,persistent=false,waterlogged=false'),
  water: idOf('minecraft:water|level=0'),
  gravel: idOf('minecraft:gravel'),
};

/**
 * A 5x5 canopy of leaves from y71 to y75 over a trunk, standing on grass at y63, in a chunk that is
 * otherwise flat grass. The canopy covers the whole 4x4 cell at (8,8), so a cell-4 grid has to speak
 * for it with one column, which is exactly the case that used to become a tower.
 */
function treeChunk() {
  const yMin = 3, yCount = 3;                     // sections 3..5 => world y 48..95
  const pal = [0, ID.dirt, ID.grass, ID.log, ID.leaves];
  const sects = new Map();
  const put = (x, y, z, id) => {
    const sy = y >> 4;
    let vox = sects.get(sy);
    if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
    vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = pal.indexOf(id);
  };
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = 48; y <= 62; y++) put(x, y, z, ID.dirt);
      put(x, 63, z, ID.grass);
    }
  }
  for (let y = 64; y <= 70; y++) put(9, y, 9, ID.log);
  for (let y = 71; y <= 75; y++) {
    for (let z = 8; z <= 11; z++) for (let x = 8; x <= 11; x++) put(x, y, z, ID.leaves);
  }

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

const shell = openShellFrame(ab(shellFromPayload(treeChunk(), { isPaint, isSolid })));

test('shell: the band byte measures the canopy, not the trunk under it', () => {
  // Leaves from 71 to 75 with a paintable trunk under them: five blocks of skin. The trunk itself is
  // solid *and* paintable, which is why a "contiguous solid" test finds nothing here.
  assert.equal(shell.surfaceAt(9, 9), 75, 'the canopy top is the surface');
  assert.equal(shell.groundAt(9, 9), 63, 'and the column stands on the forest floor');
  assert.equal(shell.bandAt(9, 9), 5, 'five blocks of it are skin');
  // Flat grass is the ground, so it has no skin and never earns a second plate.
  assert.equal(shell.bandAt(0, 0), 0);
  assert.equal(shell.bandAt(15, 15), 0);
});

/** Every quad the mesher wrote: roof or wall, and how tall it is. */
function quads(stream) {
  const p = stream.position, out = [];
  for (let q = 0; q * 6 < stream.count; q++) {
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    let miny = Infinity, maxy = -Infinity;
    for (let v = q * 6; v < q * 6 + 6; v++) {
      const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    out.push({ roof: maxy === miny, y: maxy, tall: maxy - miny, x: minx, z: minz });
  }
  return out;
}

function meshCell4(opts = {}) {
  const get = (cx, cz) => (cx === 0 && cz === 0 ? shell : null);
  return meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 4, trackStates: true, ...opts });
}

test('far mesh: a canopy is a roof at the leaves and walls across the leaves', () => {
  const { stream, stats } = meshCell4();
  assert.equal(stats.caps, 1, 'one cell in this chunk has a canopy to draw');
  const q = quads(stream);
  // The ground under the canopy is still painted, at the forest floor.
  const body = q.find((x) => x.roof && x.y === 64 && x.x === 8 && x.z === 8);
  assert.ok(body, 'the ground plate stays at the forest floor');
  // ...and the canopy is a second plate at its own top: leaves 71..75 close at y76.
  const cap = q.find((x) => x.roof && x.y === 76 && x.x === 8 && x.z === 8);
  assert.ok(cap, 'the canopy closes at its own top');
  // The sides of a canopy are the canopy: 5 blocks, not the 12 blocks down to the ground.
  const walls = q.filter((x) => !x.roof && x.x >= 8 && x.x <= 12 && x.z >= 8 && x.z <= 12);
  assert.ok(walls.length >= 4, 'the band has sides');
  for (const w of walls) {
    assert.ok(w.tall <= 5, `a canopy wall is ${w.tall} blocks tall, and the band is 5`);
    assert.ok(w.y === 76, 'and it stops at the canopy top');
  }
  assert.ok(!q.some((x) => x.tall > 5 && x.z >= 8 && x.z <= 12 && x.x >= 8 && x.x <= 12),
    'nothing in that cell extrudes from the ground to the treetops');
});

test('far mesh: caps are a switch, and off means the old flat cell', () => {
  const on = meshCell4();
  const off = meshCell4({ caps: 0 });
  assert.equal(on.stats.caps, 1);
  assert.equal(off.stats.caps, 0, 'the switch turns the caps off');
  assert.equal(off.stats.capWalls, 0);
  assert.ok(quads(off.stream).every((x) => !x.roof || x.y <= 64), 'with caps off nothing stands above the ground');
  assert.ok(on.stream.count > off.stream.count, 'caps cost geometry');
});

test('far mesh: flat ground never gets a cap, and one block per cell caps only a floating skin', () => {
  // Only the tree cell can cap; the fifteen grass cells around it are the ground itself.
  const { stream, stats } = meshCell4();
  assert.equal(stats.caps, 1, `${stats.caps} capped cells`);
  // At one block per cell a cliff or a house keeps its silhouette, because its skin runs into the ground.
  // A canopy is the exception: leaves over air, so the column stands on the forest floor and the leaves
  // are drawn as a slab. That is the difference between a tree and a solid tower of 25 columns.
  const get = (cx, cz) => (cx === 0 && cz === 0 ? shell : null);
  const fine = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 1 });
  assert.ok(fine.stats.caps >= 8, `cell 1 caps every column of a skin that stands clear of the ground (${fine.stats.caps})`);
  const q = quads(fine.stream);
  // Only walls inside the canopy count: the patch edge hangs a skirt into missing neighbours, and that is
  // a different rule (and a different test). A canopy wall may be no taller than the leaves are.
  const cx0 = 6, cx1 = 12, cz0 = 6, cz1 = 12;
  const tall = q.filter((x) => !x.roof && x.x >= cx0 && x.x <= cx1 && x.z >= cz0 && x.z <= cz1 && x.tall > 6);
  assert.equal(tall.length, 0, `no canopy column extrudes to the treetops (${tall.length} do, tallest ${Math.max(0, ...tall.map((x) => x.tall))})`);
  assert.ok(q.some((x) => x.roof && x.y === 76), 'the canopy still closes at its own top');
  assert.ok(q.some((x) => x.roof && x.y <= 65), 'and the forest floor is still painted under it');
});

test('far mesh: a cap is refused once the cell is wider than the skin it draws', () => {
  // A cap is a box as wide as the cell. At cell 8 that canopy becomes an 8x8 slab with a lid on it, which
  // is the monolith all over again, so the mesher refuses it and the cell goes back to standing on its
  // ground with the canopy surviving as colour. `?capcell` is what moves the line.
  const get = (cx, cz) => (cx === 0 && cz === 0 ? shell : null);
  const wide = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 8, trackStates: true });
  assert.equal(wide.stats.caps, 0, 'an 8-block column does not get a canopy box');
  assert.equal(wide.stats.capWalls, 0, 'and no cap walls either');
  assert.ok(quads(wide.stream).every((x) => !x.roof || x.y < 71),
    'nothing in that patch stands up at the leaves');
  const raised = meshShellPatch(assets, get, 0, 0, 1, 1, { cell: 8, capCell: 8, trackStates: true });
  assert.equal(raised.stats.caps, 1, 'the knob still allows it when asked');
});

test('far mesh: a thin skin does not earn geometry', () => {
  // Two blocks of leaves is a hedge seen from 2 km; a roof and four walls for it is not worth it.
  const yMin = 3, yCount = 3;
  const pal = [0, ID.dirt, ID.grass, ID.leaves];
  const sects = new Map();
  const put = (x, y, z, id) => {
    const sy = y >> 4;
    let vox = sects.get(sy);
    if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
    vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = pal.indexOf(id);
  };
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = 48; y <= 62; y++) put(x, y, z, ID.dirt);
      put(x, 63, z, ID.grass);
    }
  }
  for (let y = 64; y <= 65; y++) {
    for (let z = 8; z <= 11; z++) for (let x = 8; x <= 11; x++) put(x, y, z, ID.leaves);
  }
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
  const payload = packChunk({
    cx: 0, cz: 0, yMin, yCount, palette: pal,
    sections: [...sects.entries()].sort((a, b) => a[0] - b[0]).map(([y, vox]) => ({ y, single: 0, vox })),
    height, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: false,
  });
  const sh = openShellFrame(ab(shellFromPayload(payload, { isPaint, isSolid })));
  assert.equal(sh.bandAt(9, 9), 2, 'two blocks of skin');
  const { stats } = meshShellPatch(assets, (cx, cz) => (cx === 0 && cz === 0 ? sh : null), 0, 0, 1, 1,
    { cell: 4 });
  assert.equal(stats.caps, 0, 'below capDrop it stays one plate');
  const raised = meshShellPatch(assets, (cx, cz) => (cx === 0 && cz === 0 ? sh : null), 0, 0, 1, 1,
    { cell: 4, capDrop: 2 });
  assert.equal(raised.stats.caps, 1, 'and the threshold is a knob');
});

// Water is the other half of the skin rule. It is a full cube that may not paint, so a plain "count the
// solid run from the surface" walk goes straight down a lake and reports its depth: the deepest bands
// measured in this world were 39 blocks of water over a gravel bed. A cap there would draw the lake as a
// box. A film also has to stop the run *inside* a canopy, or a stream through the leaves makes the canopy
// thicker than it is.
test('shell: water is a surface, not a skin', () => {
  const yMin = 3, yCount = 3;                     // sections 3..5 => world y 48..95
  const pal = [0, ID.dirt, ID.grass, ID.gravel, ID.water, ID.leaves];
  const sects = new Map();
  const put = (x, y, z, id) => {
    const sy = y >> 4;
    let vox = sects.get(sy);
    if (!vox) { vox = new Uint16Array(4096); sects.set(sy, vox); }
    vox[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = pal.indexOf(id);
  };
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = 48; y <= 62; y++) put(x, y, z, ID.dirt);
      put(x, 63, z, ID.grass);
    }
  }
  // a 4x4 lake, bed at 62 and six blocks of water over it
  for (let z = 0; z <= 3; z++) for (let x = 0; x <= 3; x++) {
    for (let y = 62; y <= 68; y++) put(x, y, z, y === 62 ? ID.gravel : ID.water);
  }
  // leaves 74..75, then water at 73, then leaves at 72: the film is inside the skin
  for (let y = 72; y <= 75; y++) {
    for (let z = 8; z <= 11; z++) for (let x = 8; x <= 11; x++) put(x, y, z, y === 73 ? ID.water : ID.leaves);
  }
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
  const payload = packChunk({
    cx: 0, cz: 0, yMin, yCount, palette: pal,
    sections: [...sects.entries()].sort((a, b) => a[0] - b[0]).map(([y, vox]) => ({ y, single: 0, vox })),
    height, heightMotion: null, blockEntities: null, unknownStates: 0, classicSections: false,
  });
  const opts = { isPaint, isSolid, isFilm };
  const sh = openShellFrame(ab(shellFromPayload(payload, opts)));
  assert.equal(sh.surfaceAt(1, 1), 68, 'the lake surface is the water line');
  assert.equal(sh.groundAt(1, 1), 62, 'and the bed is the ground');
  assert.equal(sh.bandAt(1, 1), 0, 'the water is not a skin');
  assert.equal(sh.bandAt(9, 9), 2, 'the run stops at the water inside the leaves');

  // Even with the threshold at its loosest, a lake cell must not get a cap: its cover is a film.
  const { stats } = meshShellPatch(assets, (cx, cz) => (cx === 0 && cz === 0 ? sh : null), 0, 0, 1, 1,
    { cell: 4, capDrop: 1 });
  const cells = new Set();
  for (let z = 0; z < 16; z += 4) for (let x = 0; x < 16; x += 4) cells.add(`${x},${z}`);
  assert.ok(stats.caps <= 1, `only the leaf cell may cap, got ${stats.caps}`);
});
