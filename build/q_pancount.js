// One pan, and the question is only "how much meshing did it cost, and how many times did the same
// chunk get meshed". A pan has to mesh the new sharp ring once: if builds come out at 2x or 3x the
// ring size, the extra is repeat work, and at 26 ms a chunk that is the whole complaint.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const s = w.state;
  return { builds: s.meshBuilds, landed: s.meshed, parked: s.meshReused, unchanged: s.meshUnchanged,
    unsettled: s.meshUnsettled, deferred: s.meshDeferred ?? 0, why: { ...(s.meshByWhy ?? {}) }, dwhy: { ...(s.dirtyWhy ?? {}) },
    verts: s.verts, ring: s.ringStuck, wave: s.meshWave, jobs: s.meshJobs, dirty: s.dirty,
    payload: s.chunks, detail: s.detailMeshes, fps: +s.fps.toFixed(0), radius: s.detailCeiling };
};
await sleep(5000);
const a = snap();
const [x0, y0, z0] = w.state.target;
for (let i = 1; i <= 10; i++) { w.go(x0 + 70 * i, y0, z0 + 30 * i); await sleep(400); }
let waited = 0;
while (waited < 25000) {
  await sleep(1000); waited += 1000;
  const s = w.state;
  if ((s.meshWave ?? 0) === 0 && (s.meshJobs ?? 0) === 0 && (s.dirty ?? 0) === 0 && s.ringStuck[0] === 0) break;
}
const b = snap();
const d = (k) => (b[k] ?? 0) - (a[k] ?? 0);
const diff = (A, B) => { const o = {};
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) { const v = (B[k] ?? 0) - (A[k] ?? 0); if (v) o[k] = v; }
  return o; };
return JSON.stringify({
  settleAfterPanMs: waited,
  meshBuilds: d('builds'), meshesLanded: d('landed'), fromParkedBytes: d('parked'),
  skippedUnchanged: d('unchanged'), againstUnsettledBorder: d('unsettled'), deferredWaits: d('deferred'),
  workerCpuSeconds: +(d('builds') * 0.0263).toFixed(1),
  meshByWhy: diff(a.why, b.why), dirtyMarksByWhy: diff(a.dwhy, b.dwhy),
  ring: { before: a.ring, after: b.ring },
  detailMeshes: { before: a.detail, after: b.detail },
  payloads: { before: a.payload, after: b.payload },
  vertsMillions: { before: +(a.verts / 1e6).toFixed(1), after: +(b.verts / 1e6).toFixed(1) },
  fps: { before: a.fps, after: b.fps }, radius: b.radius,
}, null, 1);
