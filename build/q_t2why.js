// Why did a close-range A/B stay at zero pixels? The page builds the edits when asked
// (histEditsOf answered 189 writes for the chunk under the camera) but reports "0 chunks re-cut",
// and its lifetime counters say whether any mesh work happened at all after the marking.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (n = 200) => { for (let i = 0; i < n; i++) w.tick(1); return sleep(30); };
await sleep(0);
const out = {};
const before = () => ({ meshed: w.state.meshed ?? null, builds: w.histStats().builds,
  buildTotal: w.histStats().buildTotal, patches: w.histStats().patches, skipped: w.histStats().skipped,
  verts: w.state.detailVerts, dirty: w.state.dirty ?? null, meshJobs: w.state.meshJobs ?? null,
  meshWave: w.state.meshWave ?? null, ringStuck: w.state.ringStuck ?? null });
w.timeSeekRow(0);
w.settings.timeTerrain = 0; w.histSync(true); await settle();
out.offRound = before();
w.settings.timeTerrain = 1; w.histSync(true); await settle();
out.onRound = before();
const st = w.histStats();
out.stats = { marked: st.marked, capped: st.capped, chunks: st.chunks, edits: st.edits, changes: st.changes,
  builds: st.builds, buildTotal: st.buildTotal, patches: st.patches, skipped: st.skipped,
  workerPatches: st.workerPatches, workerPatchTotalMs: st.workerPatchTotalMs };
const [ccx, ccz] = [-15, 9];
out.stamp = w.histStampOf(ccx, ccz);
out.inRing = w.HIST ? [...w.HIST.marks.keys()].filter((k) => k === `${ccx},${ccz}`).length : null;
out.markAfterAsk = (() => { const m = w.histEditsOf(ccx, ccz); return m ? { stamp: m.stamp, n: m.edits.length / 2 } : null; })();
out.totalsAfterAsk = w.histTotals();
return out;
