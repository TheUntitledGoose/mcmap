(() => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const g = (n) => { const o = __world.scene.getObjectByName(n); return o ? o.children.length : -1; };
  const row = (t) => { const q = __world.state;
    return `${t} ovGroup=${g('overview')} ovBands=${q.ovBands} shellGroup=${g('shell')} shellMeshes=${q.shellPatches}` +
      ` detailVerts=${q.detailVerts} shellVerts=${q.shellVerts} ovVerts=${q.ovVerts} ovSkipped=${q.ovSkipped}` +
      ` verts=${q.verts} render=${__world.renderMs()} err=${q.frameError}`; };
  return (async () => {
    const out = [];
    await sleep(11000); __world.tick(250); out.push(row('spawn first '));
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(12000); __world.tick(250); out.push(row('far jump  '));
    __world.go(0, 112, 0); __world.orbit(0.6, 0.22, 150);
    await sleep(14000); __world.tick(300); out.push(row('back home '));
    const h = __world.pickStack(700, 430, 3).map((x) => `${x.drawn}@(${x.point.join(',')})`);
    out.push('home ray ' + (h.join(' | ') || 'SKY'));
    return out.join('\n');
  })();
})()
