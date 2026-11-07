// Close in, does the sharp mesh change when the playhead moves, and does it go away first?
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n = 120) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const out = {};
const st = () => w.stateQuads();
out.settings = { time: w.state.time, timeTerrain: w.state.timeTerrain, timeCls: w.state.timeCls,
  who: w.state.ledgerWho, decalOp: w.state.decalOp, dist: w.state.dist };

// blink detector: sample the frame readout every frame for 40 frames after a playhead jump
async function watch(label, secs) {
  w.timeSeekRow(0);
  await settle(160);
  const base = st();
  w.timeSeekRow(1);
  const dip = [];
  for (let i = 0; i < 40; i++) {
    await raf(); w.tick(1);
    dip.push(st().detailMeshes);
  }
  const after = st();
  w.timeSeekRow(0);
  await settle(160);
  const back = st();
  return { label, meshes: [base.detailMeshes, after.detailMeshes, back.detailMeshes],
    verts: [base.detailVerts, after.detailVerts, back.detailVerts],
    minDip: Math.min(...dip), dipFrames: dip.filter((m) => m < base.detailMeshes).length,
    histChunks: w.hist().chunks };
}
out.close = await watch('close', 0);
// now the same at whole-world framing for contrast
w.orbit?.(0, 1200, 0, 0);
await settle(160);
out.far = await watch('far', 0);
out.hist = w.hist();
return out;
