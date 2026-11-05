// What is actually on screen, by block state, with the colour the atlas says it should be.
//
// Screenshots answer "does it look right"; this answers "which states own the pixels, and is each one
// the colour its sprite mean plus tint would produce". Run it with a big ?fog= so haze does not wash
// the comparison out, then read `mean` against `exp`.
//
// Globals the probe respects: __probeStep (pixel stride, default 8), __probeTop (rows, default 18).
(() => {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const toSrgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const hue = ([r, g, b]) => {
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi < 40) return 'dark';
    if (hi - lo < 16) return 'grey';
    if (g >= r && g > b) return 'green';
    if (b > r && b >= g) return 'blue';
    if (r >= b && r > g) return (r > 140 && b > 140) ? 'pink' : 'warm';
    return 'other';
  };

  // The colour the mesher should put on a face, straight out of the atlas table: sprite mean (sRGB)
  // -> linear -> tint -> face shade -> back to sRGB. A row mixes tops and side walls, so the
  // expectation has to be built per pixel from the face the ray actually hit, not from "up".
  const SHADE = window.__world.faceShade || [0.55, 1, 0.8, 0.8, 0.62, 0.62];
  const N2F = { '0,-1,0': 0, '0,1,0': 1, '0,0,-1': 2, '0,0,1': 3, '-1,0,0': 4, '1,0,0': 5 };
  const expCache = new Map();
  function expectFor(key, f) {
    const ck = `${key}|${f}`;
    if (expCache.has(ck)) return expCache.get(ck);
    const st = window.__world.bake(key);
    let out = null;
    if (st) {
      // faceSprites() keeps a sprite per face and falls back to the top sprite; stateQuads(key,dir)
      // is the detail-side view of the same thing, so fall back the same way.
      let qs = window.__world.stateQuads(key, f, 0);
      if (!qs || !qs.length) qs = window.__world.stateQuads(key, 1, 0);
      const cell = qs && qs.length ? qs[0].cell : null;
      if (cell && cell.c) {
        const tinted = st.ti && cell.g ? 1 : 0;
        const t = tinted ? (window.__world.tint(key) || [1, 1, 1]) : [1, 1, 1];
        const m = SHADE[f];
        // `a` is the sprite's own mean alpha. Only translucent passes blend it in; an alphaTest sprite
        // is either there or not, and a quad that the ray hit was there.
        out = { rgb: [0, 1, 2].map((k2) => toSrgb(lin(cell.c[k2] / 255) * t[k2] * m)),
          tex: cell.id, tinted, a: cell.a ?? 1, kind: cell.kind };
      }
    }
    expCache.set(ck, out);
    return out;
  }

  const C = window.__world.composite;
  const skyRgb = (() => {
    const b = window.__world.scene && window.__world.scene.background;
    if (!b || !b.getHex) return [156, 192, 216];
    const v = b.getHex();
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  })();

  // Composite a pixel the way the rasteriser does: every translucent quad in front of the first
  // opaque one, front to back. Blending happens after the shader, into a framebuffer that already
  // holds sRGB-encoded bytes, so the mix is a byte-space lerp and not a linear-light one.
  //
  // Each layer's weight is material opacity times the sprite's own alpha. The material value alone is
  // not enough and this is the difference between describing a water pixel and predicting one.
  function stackExp(sx, sy) {
    const hits = window.__world.pickStack(sx, sy, 8) || [];
    const layers = [];
    for (const h of hits) {
      const k = h.shellState ?? h.state;
      if (!k) continue;
      const f = h.nrm ? N2F[h.nrm.join(',')] : undefined;
      const x = expectFor(k, f === undefined ? 1 : f);
      if (!x) continue;
      const a = C.layerAlpha(h.op, x.kind === 2 ? x.a : 1);
      layers.push({ rgb: x.rgb, a });
      if (a >= 1) break;
    }
    if (!layers.length) return null;
    const r = C.stackOver(skyRgb, layers);
    return { rgb: r.rgb, n: r.used, cov: +r.coverage.toFixed(2) };
  }
  // __probeDump = [[sx, sy], ...] : report the per-layer truth for a few pixels instead of running
  // the grid. Each layer says what the mesh wrote, what its sprite says it should be, and the alpha
  // the rasteriser blends it with - which of the three is wrong stops being a matter of opinion.
  if (window.__probeDump) {
    const lin2srgb = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
    return JSON.stringify(window.__probeDump.map(([sx, sy]) => {
      const fb = window.__world.pick(sx, sy);
      const stack = (window.__world.pickStack(sx, sy, 6) || []).map((h) => {
        const k = h.shellState ?? h.state;
        const f = h.nrm ? N2F[h.nrm.join(',')] : undefined;
        const x = k ? expectFor(k, f === undefined ? 1 : f) : null;
        // BufferAttribute.getX hands back the normalized value (0..1 for a u8 attribute), so the
        // bytes are already in 0..1 linear light; do not divide by 255 twice.
        const mesh = h.vcol ? [0, 1, 2].map((c) => {
          const avg = h.vcol.reduce((s2, v) => s2 + v[c], 0) / h.vcol.length;
          return lin2srgb(avg > 1 ? avg / 255 : avg);
        }) : null;
        return { k, op: h.op, face: f, exp: x ? x.rgb : null, mesh,
          tex: x ? (x.tex || '').split('/').pop() : null };
      });
      return { at: [sx, sy], fb, stack };
    }));
  }
  const step = +(window.__probeStep ?? 8);
  const g = window.__world.grab();
  if (!g) return 'no grab';
  const { w, h, buf } = g;
  const dpr = g.dpr || 1;
  // Pass 1: one pick per grid point. Pass 2 tallies, and separates a sample that sits well inside
  // one quad (all four grid neighbours hit the same quad) from one that straddles a quad border.
  // An interior sample must match the mesh exactly; a border pixel is an average of two faces, so
  // comparing those against a single face's expected colour is asking for a mismatch.
  const nr = Math.ceil(h / step), nc = Math.ceil(w / step);
  const S = new Array(nr * nc).fill(null);
  let sample = 0, sky = 0;
  for (let ry = 0; ry < nr; ry++) {
    for (let rx = 0; rx < nc; rx++) {
      const gx = rx * step, gy = ry * step;
      const i = (gy * w + gx) * 4;
      const sx = gx / dpr, sy = (h - gy - 1) / dpr;
      const p = window.__world.pickState(sx, sy);
      sample++;
      if (!p || !p.point) { sky++; continue; }
      const key = `${p.drawn}:${p.shellState ?? p.state ?? '?'}`;
      const f = p.nrm ? N2F[p.nrm.join(',')] : undefined;
      const wantExp = key.startsWith('shell') || window.__probeDetail;
      let exp = wantExp ? expectFor(key.slice(key.indexOf(':') + 1), f === undefined ? 1 : f) : null;
      // A see-through top quad (water, glass) is only part of the pixel; ask what is behind it.
      let stk = 0;
      if (exp && p.mat && p.mat.opacity < 1) {
        const s2 = stackExp(sx, sy);
        if (s2) { exp = { rgb: s2.rgb, tex: exp.tex, tinted: exp.tinted }; stk = s2.n; }
      }
      S[ry * nc + rx] = { key, quad: p.quad ?? null, f, exp, stk,
        rgb: [buf[i], buf[i + 1], buf[i + 2]] };
    }
  }
  const same = (a, b) => a && b && a.quad && a.quad === b.quad && a.key === b.key;
  const tally = new Map();
  for (let ry = 0; ry < nr; ry++) {
    for (let rx = 0; rx < nc; rx++) {
      const s = S[ry * nc + rx];
      if (!s) continue;
      const inner = same(s, S[(ry - 1) * nc + rx]) && same(s, S[(ry + 1) * nc + rx])
        && same(s, S[ry * nc + rx - 1]) && same(s, S[ry * nc + rx + 1]);
      let e = tally.get(s.key);
      if (!e) {
        tally.set(s.key, (e = { n: 0, r: 0, g: 0, b: 0, en: 0, er: 0, eg: 0, eb: 0, faces: [0, 0, 0, 0, 0, 0],
          exp: null, inner: 0, ir: 0, ig: 0, ib: 0, ien: 0, ier: 0, ieg: 0, ieb: 0, stk: 0 }));
      }
      e.n++; e.r += s.rgb[0]; e.g += s.rgb[1]; e.b += s.rgb[2]; e.stk += s.stk || 0;
      if (s.f !== undefined) e.faces[s.f]++;
      if (s.exp) { e.en++; e.er += s.exp.rgb[0]; e.eg += s.exp.rgb[1]; e.eb += s.exp.rgb[2]; e.exp = s.exp; }
      if (inner) {
        e.inner++; e.ir += s.rgb[0]; e.ig += s.rgb[1]; e.ib += s.rgb[2];
        if (s.exp) { e.ien++; e.ier += s.exp.rgb[0]; e.ieg += s.exp.rgb[1]; e.ieb += s.exp.rgb[2]; }
      }
    }
  }
  const rows = [...tally.entries()]
    .map(([k, e]) => {
      const mean = [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
      const state = k.slice(k.indexOf(':') + 1);
      const exp = e.en ? [Math.round(e.er / e.en), Math.round(e.eg / e.en), Math.round(e.eb / e.en)] : null;
      // the honest comparison: interior pixels only, against the face they are actually on
      const iexp = e.ien ? [Math.round(e.ier / e.ien), Math.round(e.ieg / e.ien), Math.round(e.ieb / e.ien)] : null;
      const imean = e.inner ? [Math.round(e.ir / e.inner), Math.round(e.ig / e.inner), Math.round(e.ib / e.inner)] : null;
      const d = (imean && iexp) ? Math.max(...[0, 1, 2].map((j) => Math.abs(imean[j] - iexp[j]))) : null;
      return { state, drawn: k.slice(0, k.indexOf(':')), px: e.n, inner: e.inner, mean, imean,
               hue: hue(mean), exp: iexp ? iexp : exp, tex: e.exp ? e.exp.tex : null,
               tint: e.exp ? e.exp.tinted : null,
               // down,up,north,south,west,east - tells you whether a mismatch is a shade question
               faces: e.faces, dmax: d,
               // mean number of stacked quads behind a translucent pixel of this state
               layers: +(e.stk / e.n).toFixed(2) };
    })
    // prefer rows where the interior test actually has pixels to judge
    .sort((a, b) => (b.inner - a.inner) || (b.px - a.px))
    .slice(0, +(window.__probeTop ?? 18));
  return JSON.stringify({ sample, sky, rows });
})()
