// PLAN 9.6: is the meshing repeated, or only slow once? The counters answer it directly:
//   meshBuilds     mesher runs actually started (the thing that costs 25 ms)
//   meshUnchanged  dirty marks that found the answer already on screen (9.6's saving)
//   meshDeferred   marks held back because a neighbour is still in flight
//   dirtyWhy       who marked chunks dirty        meshByWhy   who got meshed for it
return (async () => {
  const w = window.__world;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => {
    const s = w.state, g = w.gridEst();
    return { builds: s.meshBuilds, same: s.meshUnchanged, defer: s.meshDeferred,
      chunks: s.chunks, dirtyChunks: s.dirty, why: s.dirtyWhy, byWhy: s.meshByWhy,
      cuts: g.cuts, cutMs: g.cutMs, dirtyPatches: g.dirty, patches: s.shellPatches,
      meshed: s.meshed, keyOn: s.meshKeyOn, wr: s.workerReady, wc: s.workers };
  };
  const rows = [];
  const row = (label, a, b) => rows.push({
    label,
    keyOn: b.keyOn, workers: `${b.wr}/${b.wc}`,
    builds: b.builds - a.builds, same: b.same - a.same, defer: b.defer - a.defer,
    newChunks: b.chunks - a.chunks,
    patchCuts: b.cuts - a.cuts, cutMsAvg: b.cutMs, dirtyPatchEnd: b.dirtyPatches,
    why: b.why, byWhy: b.byWhy,
  });

  const i0 = snap();
  await sleep(5000);
  w.tick(30);
  row('stand still 5 s', i0, snap());

  const pan = async (label, dx, dz, steps) => {
    const a = snap();
    const [x0, y0, z0] = w.state.target;
    for (let i = 1; i <= steps; i++) {
      w.go(x0 + dx * i / steps, y0, z0 + dz * i / steps);
      await sleep(200);
      w.tick(8);
    }
    await sleep(900);
    w.tick(12);
    row(label, a, snap());
  };

  await pan('cold  +400 x', 400, 0, 8);
  await pan('warm  -400 x', -400, 0, 8);
  await pan('warm  +300 z', 0, 300, 6);
  await pan('warm  -300 z', 0, -300, 6);
  const f = snap();
  rows.push({ label: 'final', keyOn: f.keyOn, meshed: f.meshed, dirtyChunks: f.dirtyChunks,
    patches: f.patches, dirtyPatchEnd: f.dirtyPatches, why: f.why, byWhy: f.byWhy });
  return rows;
})();
