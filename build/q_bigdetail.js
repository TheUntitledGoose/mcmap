// what happens if someone drags close detail to the far end of the new scale
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = () => {
  for (const r of document.querySelectorAll('.panel-row')) {
    const l = r.querySelector('.panel-label');
    if (l && l.textContent === 'close detail') return r;
  }
};
const drag = (thumb) => {
  const i = row().querySelector('input');
  i.value = String(thumb);
  i.dispatchEvent(new Event('change'));
};
const sample = (t) => {
  const s = w.state;
  return {
    t, ask: s.detailCeiling, ring: s.detailRadius, payload: s.payloadRadius,
    chunks: s.chunks, verts: s.verts, detVerts: s.detailVerts, shell: s.shellVerts,
    lod: s.lodVerts, fps: +s.fps.toFixed(1), dirty: s.dirty, wave: s.meshWave,
    stuck: s.ringStuck, parkMB: s.bytesHeld ? +(s.bytesHeld / 1e6).toFixed(1) : null,
  };
};
const out = { rows: [] };
await sleep(4000);
out.at8 = sample('default 8');
  drag(18);                                   // the far end: 64 chunks
  for (const t of [1000, 3000, 6000, 10000]) { await sleep(t === 1000 ? 1000 : 2000); w.tick(2); out.rows.push(sample('+' + t)); }
out.after = w.state;
return JSON.stringify(out, null, 1);
