// 9.5a A/B: indexed detail meshes vs the soup, at a framing where the detail layer is the bill.
//
// Reports, per layer, how many geometries are drawn and what they cost in GPU bytes; then a settled
// fps and GPU-time sample. The point of splitting by layer is that only the *detail* layer changed:
// the shell patch and baked LOD streams are still soup, and if those numbers move between runs the
// framing did not settle and nothing here is comparable.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = () => w.state;
// Settle: nothing dirty, no mesh jobs in flight. Bounded, because a ring this size can take a while.
for (let i = 0; i < 60; i++) {
  if (st().dirty === 0 && st().meshJobs === 0 && st().inflight === 0) break;
  await sleep(500);
}
const t0 = performance.now();
let frames = 0;
const tick = () => { frames++; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
await sleep(2500);
const fps = frames / ((performance.now() - t0) / 1000);

const lay = {};
let indexed = 0, soup = 0, posBytes = 0, idxBytes = 0, tris = 0, ix16 = 0, ix32 = 0, ixMaxVerts = 0;
w.scene.traverse((o) => {
  if (!o.isMesh || !o.visible) return;
  const g = o.geometry;
  const n = g?.attributes?.position?.count ?? 0;
  if (!n) return;
  const name = (o.name || '?').replace(/[0-9].*$/, '').replace(/[^a-z]/gi, '') || '?';
  const key = name.length > 8 ? name.slice(0, 8) : name;
  const rec = (lay[key] ??= { meshes: 0, verts: 0, idx: 0, ixed: 0 });
  rec.meshes++; rec.verts += n;
  const ic = g.index ? g.index.count : 0;
  rec.idx += ic;
  if (g.index) { indexed++; rec.ixed++; } else soup++;
  posBytes += n * (12 + 8 + 4);                 // position f32 + uv f32 + colour u8
  // Never assume the index width: the mesher hands back 16-bit indices when the mesh fits them and
  // 32-bit when it does not. A bill that guesses 4 bytes reports half the saving there is.
  if (ic) idxBytes += ic * (g.index.array.BYTES_PER_ELEMENT ?? 4);
  tris += ic ? ic / 3 : n / 3;
});
const r = w.res();
return JSON.stringify({
  url: location.search,
  parsed: { radius: st().radius, detailPx: st().detailPx, detailPixels: st().detailPixels,
    meshIndex: st().meshIndex, aa: st().aa },
  settled: { dirty: st().dirty, jobs: st().meshJobs, chunks: st().chunks, inflight: st().inflight },
  fps: +fps.toFixed(1), gpuMs: r.gpuMs, gpuSamples: r.samples,
  verts: st().verts, tris: Math.round(tris), drawn: st().drawn,
  indexedMeshes: indexed, soupMeshes: soup,
  vramMB: +((posBytes + idxBytes) / 1048576).toFixed(1),
  vertsMB: +(posBytes / 1048576).toFixed(1), idxMB: +(idxBytes / 1048576).toFixed(1),
  parkMB: st().parkMB, meshBytesHit: st().meshBytesHit, meshBytesGhost: st().meshBytesGhost,
  layers: lay,
});
