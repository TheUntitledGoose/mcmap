import fs from 'node:fs';
const p = 'tests/web-mesh.test.mjs';
const s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('// A section stored as one repeated state');
if (i < 0) throw new Error('anchor not found');
const repl = `// A section stored as one repeated state is walked only along the outside of its 16^3 box, a 3x cut
// in section cost. That is only allowed to be a speed-up: the same voxels written out longhand must
// produce byte-identical triangles, including their shading.
test('a section stored once produces the same mesh as a section stored 4096 times', () => {
  const assets = loadAssets();
  const stone = assets.indexOf('minecraft:stone') + 1;
  const grass = assets.indexOf('minecraft:grass_block|snowy=false') + 1;
  const air = assets.indexOf('minecraft:air') + 1;
  assert.ok(stone > 0 && grass > 0 && air > 0, 'the test states must be in the atlas table');
  assert.ok(assets.states[stone - 1].cube, 'stone must be on the cube fast path');
  assert.ok(assets.states[grass - 1].fc === 1, 'grass_block must fill its box without the fast path');

  // One section of solid stone plus one ragged layer above it, so the uniform fast path and the
  // general walk both run over the same chunk. Palette slots, not state ids, go in \`vox\`.
  const vox = new Uint16Array(4096).fill(2);                      // slot 2 = air
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      vox[(1 << 8) | (lz << 4) | lx] = 1;                         // slot 1 = grass_block floor
      vox[(2 << 8) | (lz << 4) | lx] = (lx + lz) % 2 ? 0 : 2;     // slot 0 = stone, ragged
    }
  }
  const chunk = openChunk(toArrayBuffer(packChunk({
    cx: 4, cz: 4, yMin: 32, yCount: 3,
    palette: [stone, grass, air],
    sections: [{ y: 2, single: 0, vox }, { y: 3, single: 1, vox: null }, { y: 4, single: 1, vox: null }],
    height: null, heightMotion: null, blockEntities: null,
    unknownStates: 0, classicSections: false,
  })));
  // The writer collapses a section that repeats one state; expand it again to get the identical
  // voxel grid in longhand form.
  const longhand = {
    ...chunk,
    sections: chunk.sections.map((s) =>
      (s.single ? { ...s, single: 0, vox: new Uint16Array(4096).fill(s.single) } : s)),
  };
  assert.ok(chunk.sections.some((s) => s.single), 'the writer must collapse a solid section');

  const at = () => -1;                                   // unknown neighbours: every face shows
  const a = meshChunk(assets, chunk, at, { ao: true });
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
