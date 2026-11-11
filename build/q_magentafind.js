// What is that magenta mass? Scan the framebuffer for magenta, then ask the page what it hit there.
// Magenta is the missing-texture placeholder and the unknown-state stand-in, so a room-sized patch of it is
// a claim about the atlas, not about the players' build. This names the state and the layer that painted it.
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(0);   // browser-probe only wraps a file in an async IIFE when it sees `await`
const hit = w.pickState(innerWidth * 0.22, innerHeight * 0.66);
const cam = w.camPos ? w.camPos() : null;
const grab = w.grab ? w.grab() : null;
const out = { magentaPx: 0, samples: [], err: [] };
if (grab?.buf) {
  const { buf, w: gw, h: gh } = grab;
  const seen = new Map();
  for (let py = 0; py < gh; py += 2) {
    for (let px = 0; px < gw; px += 2) {
      const i = (py * gw + px) * 4;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      if (r > 170 && b > 170 && g < Math.min(r, b) * 0.62) {
        out.magentaPx++;
        // Keep a coarse spatial spread of hits instead of one pixel repeated.
        const k = `${Math.floor(px / 60)}_${Math.floor(py / 60)}`;
        if (!seen.has(k) && seen.size < 10) {
          seen.set(k, 1);
          const sx = (px / gw) * innerWidth, sy = (1 - py / gh) * innerHeight;
          const p = w.pickState(sx, sy);
          out.samples.push({ sx: Math.round(sx), sy: Math.round(sy), block: p?.block, state: p?.state,
            drawn: p?.drawn, cls: p?.cls, dist: p?.dist, quad: p?.quad });
        }
      }
    }
  }
  out.samples.sort((a, b) => (a.state || '').localeCompare(b.state || ''));
}
out.merged = {};
for (const s of out.samples) {
  const k = `${s.state} drawn:${s.drawn} cls:${s.cls}`;
  out.merged[k] = (out.merged[k] || 0) + 1;
}
out.pickCentre = hit ? { block: hit.block, state: hit.state, drawn: hit.drawn, dist: hit.dist } : null;
out.time = (() => { const t = w.time(); return { markers: t.quads, drawn: t.drawn, look: t.look,
  culledFaces: t.culledFaces, fullyInside: t.fullyInside, deduped: t.dedupedClaims, err: t.err || '', fact: t.fact || '' }; })();
out.pageErrors = (w.state && (w.state.frameErrors ?? w.state.frameError)) ?? 0;
return out;
