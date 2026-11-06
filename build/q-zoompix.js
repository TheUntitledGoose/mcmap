// Same screen grid, near (voxel detail) and far (shell): what the framebuffer shows, and what colour
// the mesh itself carried. Run twice on the same goto: dist=300 puts the lake in the detail ring,
// dist=1200 puts the same lake in the far grid.
(() => {
  const st = __world.state;
  const out = { dist: st.dist, target: st.cam, detailRadius: st.detailRadius, samples: [] };
  for (let i = 0; i < 12; i++) {
    const sx = 540 + i * 20, sy = 410 + (i % 4) * 20;
    const px = __world.pick(sx, sy);                    // framebuffer pixel
    const p = __world.pickState(sx, sy);                // what drew it
    if (!px || !p) { out.samples.push({ sx, sy, miss: 1 }); continue; }
    const vc = p.vcol && p.vcol[0] ? p.vcol[0].map((v) => Math.round(v * 255)) : null;
    out.samples.push({
      sx, sy, fb: [px[0], px[1], px[2]].join(','), drawn: p.drawn,
      state: (p.state || '').replace('minecraft:', ''), y: Math.round(p.point[1]),
      vcol: vc ? vc.join(',') : null,
    });
  }
  const ok = out.samples.filter((s) => s.fb);
  const mean = (list, key) => [0, 1, 2].map((k) =>
    Math.round(list.reduce((a, s) => a + +s[key].split(',')[k], 0) / list.length));
  const by = (d) => ok.filter((s) => s.drawn === d);
  out.n = ok.length;
  out.fbMean = ok.length ? mean(ok, 'fb') : null;
  out.detailN = by('detail').length;
  out.shellN = by('shell').length;
  out.detailFb = by('detail').length ? mean(by('detail'), 'fb') : null;
  out.shellFb = by('shell').length ? mean(by('shell'), 'fb') : null;
  const dv = by('detail').filter((s) => s.vcol), sv = by('shell').filter((s) => s.vcol);
  out.detailVc = dv.length ? mean(dv, 'vcol') : null;
  out.shellVc = sv.length ? mean(sv, 'vcol') : null;
  return JSON.stringify(out);
})();
