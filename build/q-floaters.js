(() => {
  const W = innerWidth, H = innerHeight, rows = [], seen = {}, ys = [];
  for (let iy = 2; iy < 9; iy++) {
    let line = '';
    for (let ix = 1; ix < 13; ix++) {
      const h = __world.pickStack(Math.round(W * ix / 13), Math.round(H * iy / 10), 3);
      if (!h.length) { line += '.'; continue; }
      const a = h[0];
      const st = ((a.state ?? a.shellState ?? '?').split(':')[1] ?? '?').slice(0, 14);
      seen[st] = (seen[st] || 0) + 1;
      ys.push(a.point[1]);
      line += ({ detail: 'D', shell: 'S', lod: 'L', overview: 'O' })[a.drawn] || '?';
    }
    rows.push(line);
  }
  return JSON.stringify({
    rows, seen,
    yRange: ys.length ? [Math.min(...ys), Math.max(...ys)] : null,
    cam: __world.camPos ? __world.camPos() : null,
    detailMeshes: __world.state.detailMeshes, detailVerts: __world.state.detailVerts,
  });
})()
