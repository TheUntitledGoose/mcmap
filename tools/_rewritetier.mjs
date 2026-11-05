import fs from 'node:fs';
const p = 'tests/web-shell.test.mjs';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf("\n// LOD makes neighbouring chunks disagree");
if (start < 0) throw new Error('tier test not found');
s = s.slice(0, start) + `
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
      const k = \`\${x},\${z}\`;
      assert.ok(!seen.has(k), \`\${what}: two walls at the same place (\${k}) would z-fight\`);
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
    \`the coarse wall must cover the whole drop: \${JSON.stringify(wb)}\`);
  assert.equal(b.stats.columns, 16 + 256, 'each chunk keeps its own cell size');

  // The drop runs the other way too: coarse and low, fine and tall.
  const c = meshShellPatch(assets, (cx, cz) => (cz === 0 ? mk(cx, cx === 1 ? 104 : 100) : null),
    0, 0, 2, 1, { maxSkirt: 0, cellFor: (cx) => (cx === 0 ? 4 : 1) });
  const wc = wallsOf(c.stream);
  assert.equal(wc.length, 16, 'the 16 fine tall columns each close their own strip');
  assert.ok(wc.every((w) => w[0] === 16 && w[1] === 101 && w[2] === 105),
    \`no light gap at a coarse-to-fine border: \${JSON.stringify(wc)}\`);
  noDuplicates(wc, 'coarse low side');
});
`;
fs.writeFileSync(p, s);
console.log('tier test rewritten');
