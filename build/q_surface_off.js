(() => {
  const w = window.__world;
  const s = w.state;
  return JSON.stringify({
    href: location.href.split('?')[1],
    surfaceSetting: w.settings.surface,
    surfaceOn: s.surfaceOn,
    caves: w.settings.caves,
    darkcut: w.settings.darkcut,
    buried: w.settings.buried,
    buriedSky: w.settings.buriedSky,
    verts: s.verts,
    shellVerts: s.shellVerts,
    fps: +s.fps.toFixed(2),
  });
})()
