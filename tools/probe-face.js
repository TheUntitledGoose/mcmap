// End-to-end face-orientation probe.
//
// Picks an opaque block with an exposed side face, a wide air corridor in front of it, and a sprite
// that differs top-to-bottom. It looks at that face straight on and asks, for every sampled pixel:
// of the eight ways a sprite can be oriented (the mapping the mesher requested, plus 90/180/270
// degree rotations, a horizontal flip, a vertical flip and their combinations), which one predicts
// this pixel's colour? The tally is the answer, and voting per pixel means a minority of occluded
// pixels cannot outvote the face itself.
//
// The hypotheses are expressed *relative to the uv the mesher asked for*, so a win for "requested"
// does not depend on Minecraft's per-face uv conventions (north and east legitimately sample the
// sprite flipped). It only says: the texels the mesher asked for are the texels the framebuffer
// shows, on real chunk geometry - which is what tools/probe-flat.js has already shown for the flat
// debug quad.
//
// Usage: node tools/browser-probe.mjs --url "http://127.0.0.1:8765/?debug=1" --wait 12000 --eval-file tools/probe-face.js
(() => {
  const keyAt = (x, y, z) => __world.at(x, y, z);
  const isAir = (k) => k === null || k === 'air' || k.endsWith(':air');

  const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const l2s = (c) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  const dist3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const avg = (list) => list.reduce((a, c) => a.map((v, i) => v + c[i]), [0, 0, 0]).map((v) => v / list.length);

  // Hypotheses in sprite space, relative to where the mesher asked to sample.
  const HYP = [
    { name: 'requested', f: (u, v) => [u, v] },
    { name: 'rot180', f: (u, v) => [1 - u, 1 - v] },
    { name: 'rot90', f: (u, v) => [v, 1 - u] },
    { name: 'rot270', f: (u, v) => [1 - v, u] },
    { name: 'vflip', f: (u, v) => [u, 1 - v] },
    { name: 'hflip', f: (u, v) => [1 - u, v] },
    { name: 'transpose', f: (u, v) => [v, u] },
    { name: 'rot90+vflip', f: (u, v) => [1 - v, 1 - u] },
  ];

  const vContrast = (texIdx) => {
    const c = __world.cell(texIdx);
    if (!c || c.w < 8 || c.h < 8) return 0;
    const band = (frac) => {
      const px = [];
      for (let i = 0; i < 8; i++) {
        const p = __world.atlasPixel(c.u0 + (c.u1 - c.u0) * ((i + 0.5) / 8), c.v0 + (c.v1 - c.v0) * frac);
        if (p) px.push(p.slice(0, 3));
      }
      return px.length ? avg(px) : null;
    };
    const top = band(0.15), bot = band(0.85);
    return top && bot ? dist3(top, bot) : 0;
  };

  // Two blocks of air, three cells wide and tall, in front of the face: without it leaves and
  // neighbouring trunks sit between the camera and the face and the vote measures the scenery.
  const corridorClear = (x, y, z, n, depth) => {
    for (let d = 1; d <= depth; d++) {
      for (let a = -1; a <= 1; a++) {
        for (let v = -1; v <= 1; v++) {
          const lx = x + n[0] * d + (n[2] ? a : 0);
          const lz = z + n[2] * d + (n[0] ? a : 0);
          if (!isAir(keyAt(lx, y + v, lz))) return false;
        }
      }
    }
    return true;
  };

  const T = __world.state.target;
  const NRM = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  const diag = { blocks: 0, singleQuadFaces: 0, contrastOk: 0, corridorOk: 0, bestContrastSeen: 0, depth: 0 };
  let best = null;
  // prefer a longer clear corridor (the camera then sits outside it), but accept a shorter one
  for (const depth of [3, 2]) {
    for (let dx = -12; dx <= 12; dx++) {
      for (let dz = -12; dz <= 12; dz++) {
        for (let dy = -6; dy <= 6; dy++) {
          const x = T[0] + dx, y = T[1] + dy, z = T[2] + dz;
          const k = keyAt(x, y, z);
          if (!k || isAir(k)) continue;
          if (depth === 3) diag.blocks++;
          for (const dir of [3, 2, 5, 4]) {
            const quads = __world.stateQuads(k, dir);
            if (!quads || quads.length !== 1 || !quads[0].cell) continue;
            if (depth === 3) diag.singleQuadFaces++;
            const contrast = vContrast(quads[0].tex);
            if (depth === 3 && contrast > diag.bestContrastSeen) diag.bestContrastSeen = +contrast.toFixed(1);
            if (contrast < 40) continue;
            if (depth === 3) diag.contrastOk++;
            if (!corridorClear(x, y, z, NRM[dir], depth)) continue;
            diag.corridorOk++;
            diag.depth = depth;
            const cand = { x, y, z, dir, k, tex: quads[0].tex, cell: quads[0].cell, contrast, depth };
            if (!best || contrast > best.contrast) best = cand;
          }
        }
      }
    }
    if (best) break;
  }
  if (!best) return { error: 'no face with a single quad, a clear corridor and top/bottom contrast', diag };

  const n = NRM[best.dir];
  const yaw = Math.atan2(n[0], -n[2]);
  // aim the rig at the face itself: orbit() keeps looking at rig.target, so probing a face that is
  // not the target photographs whatever happens to sit at the old target
  __world.go(best.x + 0.5 + n[0] * 0.5, best.y + 0.5 + n[1] * 0.5, best.z + 0.5 + n[2] * 0.5);
  __world.orbit(yaw, 0, best.depth + 0.6);
  __world.sync();

  const tp = __world.texProbe(best.x, best.y, best.z, best.dir);
  if (!tp.tri) return { ...best, error: tp.error };
  const tri = tp.tri;
  const shade = tri[0].col;

  // Work in the face's own 2d frame: fu along the face's horizontal world axis, fvTop down from the
  // top edge. Using the same frame in both directions makes the sign convention cancel out.
  const hAxis = n[0] ? 'z' : 'x';
  const toLocal = (p) => [hAxis === 'x' ? p[0] - best.x : p[2] - best.z, best.y + 1 - p[1]];
  const toWorld = (fu, fv) => {
    const y = best.y + 1 - fv;
    // the face plane sits half a block out from the block centre, on the side the normal points
    return hAxis === 'x'
      ? [best.x + fu, y, best.z + 0.5 + n[2] * 0.5]
      : [best.x + 0.5 + n[0] * 0.5, y, best.z + fu];
  };
  const L = tri.map((v) => ({ p: toLocal(v.p), uv: v.uv }));
  const c = best.cell;
  const toSprite = (uv) => [(uv[0] - c.u0) / (c.u1 - c.u0), (uv[1] - c.v0) / (c.v1 - c.v0)];

  // One bulk read beats a readPixels per pixel: the main scene costs ~0.1 s to render.
  const g = __world.grab();
  const dpr = g.dpr;
  const fb = (sx, sy) => {
    const gx = Math.floor((sx + 0.5) * dpr), gy = Math.floor((innerHeight - sy - 0.5) * dpr);
    if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) return null;
    const i = (gy * g.w + gx) * 4;
    return [g.buf[i], g.buf[i + 1], g.buf[i + 2]];
  };

  const [a, b, cc] = L;
  const area2 = (b.p[0] - a.p[0]) * (cc.p[1] - a.p[1]) - (cc.p[0] - a.p[0]) * (b.p[1] - a.p[1]);
  if (!area2) return { ...best, error: 'degenerate triangle in face-local space' };

  const tally = Object.fromEntries(HYP.map((h) => [h.name, 0]));
  let samples = 0, skipped = 0, sumErr = 0;
  const GRID = 16;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID - i; j++) {
      // barycentric sample inside the measured triangle
      const w2 = (i + 0.5) / GRID, w3 = (j + 0.5) / GRID;
      if (w2 + w3 >= 1) { skipped++; continue; }
      const w1 = 1 - w2 - w3;
      const fu = w1 * a.p[0] + w2 * b.p[0] + w3 * cc.p[0];
      const fv = w1 * a.p[1] + w2 * b.p[1] + w3 * cc.p[1];
      const suv = [0, 1].map((k2) => w1 * a.uv[k2] + w2 * b.uv[k2] + w3 * cc.uv[k2]);
      const w = toWorld(fu, fv);
      const s = __world.screenOf(w[0], w[1], w[2]);
      if (!s || s.ndcz < 0.9) { skipped++; continue; }
      const got = fb(s.x, s.y);
      if (!got) { skipped++; continue; }
      const [su, sv] = toSprite(suv);
      let win = null, winD = 1e9;
      for (const h of HYP) {
        const [hu, hv] = h.f(su, sv);
        const t2 = __world.atlasPixel(c.u0 + (c.u1 - c.u0) * hu, c.v0 + (c.v1 - c.v0) * hv);
        if (!t2) continue;
        const pred = t2.slice(0, 3).map((ch, k2) => l2s(s2l(ch / 255) * shade[k2]));
        const d = dist3(pred, got);
        if (d < winD) { winD = d; win = h.name; }
      }
      if (!win) { skipped++; continue; }
      tally[win]++; samples++; sumErr += winD;
    }
  }
  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  return {
    face: [best.x, best.y, best.z, best.dir], state: best.k, texture: c.id,
    spriteContrast: +best.contrast.toFixed(1), exactTri: !!tp.exact,
    samples, skipped, meanErrIfBest: +(sumErr / Math.max(1, samples)).toFixed(1),
    diag,
    votes: ranked.map(([name, v]) => `${name}:${v}`).join(' '),
    winner: ranked[0][0],
    correct: ranked[0][0] === 'requested' && ranked[0][1] > (ranked[1]?.[1] ?? 0),
  };
})()
