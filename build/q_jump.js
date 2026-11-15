// Scratch probe: jump to a fresh area and watch what the page waits for. Statements, not an IIFE.
const w = window.__world;
const s = () => w.state;
const rows = [];
for (let i = 0; i < 7; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const x = s();
  rows.push([+x.fps.toFixed(0), x.chunks, x.inflight, x.queued, x.dirty, x.ringStuck, x.meshBuilds,
    x.verts, +x.cpuRenderMs.toFixed(1)].join('/'));
}
const x = s();
const out = { view: location.search, dist: x.dist, dr: x.detailRadius, pr: x.payloadRadius,
  rows, fpsEnd: +x.fps.toFixed(1), chunks: x.chunks, verts: x.verts, builds: x.meshBuilds,
  unch: x.meshUnchanged, why: x.dirtyWhy, errors: (window.__probeErrors || []).slice(0, 3) };
console.log('JP ' + JSON.stringify(out));
return out;
