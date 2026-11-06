// 9.5a pan A/B: what one chunk mesh costs, measured on the worker, with and without an index buffer.
//
// `meshed` and `meshMs` in the debug state are the pool's own counters (count and running mean of the
// worker's measured meshChunk time), so the difference across a pan is the mesher's real price for the
// chunks that pan swept. `builds` is the same work count q_pancount reports, which is the check that
// both runs swept the same ground.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => w.state;
const snap = () => ({
  builds: st().meshed, msMean: st().meshMs, msMax: st().meshMax, verts: st().verts,
  detail: st().detailMeshes, payloads: st().chunks, ring: st().ringStuck,
  reused: st().meshReused,
  why: st().meshByWhy ?? {}, dwhy: st().dirtyWhy ?? {},
});
const parkBefore = st().parkThenBuild;
await sleep(5000);
const a = snap();
const [x0, y0, z0] = st().target;
for (let i = 1; i <= 10; i++) { w.go(x0 + 70 * i, y0, z0 + 30 * i); await sleep(400); }
let waited = 0;
while (waited < 30000) {
  await sleep(1000); waited += 1000;
  const s = st();
  if ((s.meshWave ?? 0) === 0 && (s.meshJobs ?? 0) === 0 && (s.dirty ?? 0) === 0 && s.ringStuck[0] === 0) break;
}
const b = snap();
const dB = b.builds - a.builds;
// running means -> the mean over the builds that happened during the pan
const panMs = dB > 0 ? (b.builds * b.msMean - a.builds * a.msMean) / dB : 0;
let idxElems = 0, ixVerts = 0, soupVerts = 0, ixMeshes = 0, ixBytes = 0, vertBytes = 0;
w.scene.traverse((o) => {
  if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position?.count) return;
  const g = o.geometry, n = g.attributes.position.count;
  vertBytes += n * 24;
  if (g.index) { ixMeshes++; ixVerts += n; idxElems += g.index.count; ixBytes += g.index.array.BYTES_PER_ELEMENT * g.index.count; }
  else soupVerts += n;
});
return JSON.stringify({
  parsed: { meshIndex: st().meshIndex, radius: st().radius, detailPixels: st().detailPixels, caves: st().caves },
  settleAfterPanMs: waited,
  buildsDuringPan: dB,
  msPerBuildDuringPan: +panMs.toFixed(2),
  msPerBuildBefore: +a.msMean.toFixed(2), msPerBuildAfter: +b.msMean.toFixed(2),
  maxBuildMs: +b.msMax.toFixed(1),
  workerCpuSeconds: +(dB * panMs / 1000).toFixed(1),
  settleMsBefore: a.msMean,
  verts: { before: +(a.verts / 1e6).toFixed(2), after: +(b.verts / 1e6).toFixed(2) },
  detailMeshes: { before: a.detail, after: b.detail },
  payloads: { before: a.payloads, after: b.payloads },
  parkedBytesReused: st().meshReused - (a.reused ?? 0), parkMB: st().meshCacheMB,
  parkThenBuildFakeWins: st().parkThenBuild - parkBefore,
  drawn: { ixMeshes, soupVerts: +(soupVerts / 1e6).toFixed(2), ixVerts: +(ixVerts / 1e6).toFixed(2),
    idxElems: +(idxElems / 1e6).toFixed(2) },
  geometryMB: { verts: +(vertBytes / 1048576).toFixed(1), index: +(ixBytes / 1048576).toFixed(1),
    total: +((vertBytes + ixBytes) / 1048576).toFixed(1) },
  fps: +st().fps.toFixed(0),
}, null, 0);
