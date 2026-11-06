(async () => {
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of [200, 400, 1200]) {
  __world.orbit(null, null, d);
  for (let i = 0; i < 40; i++) { __world.tick(1, 16); await sleep(6); }
  await sleep(1200);
  const s = __world.state;
  // how tall is the tallest thing the far layer paints, and how spiky is it?
  let tall = 0, near = 0, sum = 0, n = 0;
  for (let cx = 182; cx <= 190; cx++) for (let cz = 121; cz <= 129; cz++) {
    const sh = __world.shellAt(cx, cz);
    if (!sh || !sh.tops) continue;
    near++;
    for (const v of sh.tops) if (v > 0) { sum += v; n++; if (v > tall) tall = v; }
  }
  rows.push({ dist: s.dist, verts: s.verts, shellVerts: s.shellVerts, shellPatches: s.shellPatches,
    shellHeld: s.shellHeld, meshAvgMs: s.meshAvgMs, tallCol: tall, sampleChunks: near,
    err: s.err });
}
return rows;

})()
