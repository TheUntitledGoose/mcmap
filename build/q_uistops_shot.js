// photograph the close-detail row mid-scale, and the world it buys
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of document.querySelectorAll('details.panel-section')) d.open = true;
w.set('radius', 24);
w.orbit(0.6, 0.5, 190);
w.tick(3);
await sleep(9000);
w.tick(3);
await sleep(3000);
const row = [...document.querySelectorAll('.panel-row')]
  .map((r) => [r.querySelector('.panel-label')?.textContent, r.querySelector('.panel-val')?.textContent])
  .filter(([, v]) => v !== undefined);
const s = w.state;
return JSON.stringify({
  radiusRow: row.slice(0, 3), radius: s.radius, ring: s.detailRadius, verts: s.verts,
  chunks: s.chunks, fps: +s.fps.toFixed(1), detailMB: +(s.bytesHeld / 1e6).toFixed(0),
  stuck: s.ringStuck,
});
