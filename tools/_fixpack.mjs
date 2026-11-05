import fs from 'node:fs';
const p = 'tests/pack-output.test.mjs';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf("\n// The mesher cannot tell a grey mask");
if (start < 0) throw new Error('appended block not found');
s = s.slice(0, start) + `
// The mesher cannot tell a grey mask from an authored-colour sprite by name, and getting that wrong
// paints whole hillsides olive, so the atlas measures both facts out of the pixels.
const PACKED = existsSync(\`\${OUT}/atlas.json\`) ? \`\${OUT}/atlas.json\` : 'build/assets/atlas.json';
test('atlas textures carry a measured mean colour and a grey-mask flag',
  { skip: existsSync(PACKED) ? false : 'no packed atlas yet' }, () => {
  const a = JSON.parse(readFileSync(PACKED, 'utf8'));
  const byId = new Map(a.textures.map((t) => [t.id, t]));
  for (const t of a.textures) {
    assert.ok(Array.isArray(t.c) && t.c.length === 3, \`\${t.id} needs an [r,g,b] mean\`);
    for (const v of t.c) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, \`\${t.id} mean channel \${v}\`);
    assert.ok(t.g === 0 || t.g === 1, \`\${t.id} grey-mask flag must be 0 or 1\`);
  }
  // The pair that used to be wrong together: vanilla ships the top of a grass block as a grey mask
  // and its side already brown. Same block, opposite answers.
  const top = byId.get('minecraft:block/grass_block_top');
  const side = byId.get('minecraft:block/grass_block_side');
  assert.ok(top && side, 'vanilla grass sprites must be in the atlas');
  assert.equal(top.g, 1, 'grass_block_top is a tintable grey mask');
  assert.equal(side.g, 0, 'grass_block_side already carries its colour');
  assert.ok(side.c[0] > side.c[2] * 1.5, \`grass_block_side mean should be brown, got \${side.c}\`);
  // Leaves sprites are dithered rather than literally grey, which is why the flag is a spread test.
  const leaves = byId.get('minecraft:block/oak_leaves');
  assert.ok(leaves && leaves.g === 1, 'oak_leaves is a dithered grey mask');
});
`;
fs.writeFileSync(p, s);
console.log('pack-output test rewritten');
