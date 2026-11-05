import fs from 'node:fs';
const p = 'tests/web-mesh.test.mjs';
const s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('// The mesher walks a uniform section only along the outside of its box.');
if (i < 0) throw new Error('anchor not found');
const repl = `// A section stored as one repeated state is walked only along the outside of its 16^3 box, which is
// a 3x cut in section cost. That is only allowed to be a speed-up: the same voxels written out
// longhand must produce byte-identical triangles, including their shading.
test('a section stored once produces the same mesh as a section stored 4096 times', () => {
  const assets = loadAssets();
  const stone = assets.indexOf('minecraft:stone') + 1;
  const grass = assets.indexOf('minecraft:grass_block|snowy=false') + 1;
  const air = assets.indexOf('minecraft:air') + 1;
  assert.ok(stone > 0 && grass > 0 && air > 0, 'the test states must be in the atlas table');
  assert.ok(assets.states[stone - 1].cube, 'stone must be on the cube fast path');
  assert.ok(assets.states[grass - 1].fc === 1, 'grass_block must fill its box without the fast path');

  // One section of solid stone plus one ragged grass layer, so the uniform fast path and the
  // general walk both run over the same chunk.
  const vox = new Uint16Array(4096).fill(air);
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      vox[(0 << 8) | (lz << 4) | lx] = grass;
      vox[(1 << 8) | (lz << 4) | lx] = (lx + lz) % 2 ? stone : air;   // ragged, not a slab
    }
  }
  const mk = (collapsed) => openChunk(toArrayBuffer(packChunk({
    cx: 4, cz: 4, yMin: 0, yCount: 2,
    palette: [stone, grass, air],
    sections: [
      { y: 0, single: collapsed ? 1 : 0, vox: collapsed ? null : new Uint16Array(4096).fill(1) },
      { y: 1, single: 0, vox },
    ],
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, classicSections: false,
  })));

  const packed = mk(true), longhand = mk(false);
  assert.ok(packed.sections[0].single, 'the writer must have collapsed the solid section');
  const at = () => -1;                                   // unknown neighbours: every face shows
  const a = meshChunk(assets, packed, at, { ao: true });
  const b = meshChunk(assets, longhand, at, { ao: true });
  for (let i = 0; i < 3; i++) {
    assert.equal(a.streams[i].count, b.streams[i].count, \`pass \${i} vertex count differs\`);
    assert.deepEqual([...a.streams[i].position], [...b.streams[i].position], \`pass \${i} positions differ\`);
    assert.deepEqual([...a.streams[i].uv], [...b.streams[i].uv], \`pass \${i} texture differs\`);
    assert.deepEqual([...a.streams[i].color], [...b.streams[i].color], \`pass \${i} shading differs\`);
  }
  assert.ok(a.stats.faces > 200, \`expected faces to be emitted, got \${a.stats.faces}\`);
  console.log(\`# uniform-section fast path: \${a.stats.faces} faces, \${a.stats.culled} culled, \${a.stats.air} air\`);
});
`;
fs.writeFileSync(p, s.slice(0, i) + repl);
