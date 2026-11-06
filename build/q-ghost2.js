(() => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const g = (n) => { const o = __world.scene.getObjectByName(n); return o ? o.children.length : 'none'; };
  const row = (t) => { const q = __world.state;
    return `${t} shellGroup=${g('shell')} shellMeshes=${q.shellPatches} ovGroup=${g('overview')} ovBands=${q.ovBands} detailVerts=${q.detailVerts} shellVerts=${q.shellVerts} ovVerts=${q.ovVerts} verts=${q.verts} render=${__world.renderMs()} err=${q.frameError}`; };
  return (async () => {
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(12000); __world.tick(250);
    const out = [row('near  ')];
    __world.orbit(0.6, 0.5, 26000); await sleep(10000); __world.tick(200); out.push(row('far   '));
    __world.orbit(0.6, 0.22, 150); await sleep(12000); __world.tick(250); out.push(row('back  '));
    for (let i = 0; i < 4; i++) { __world.orbit(null, null, 150 + (i % 2) * 900); await sleep(2500); __world.tick(80); }
    __world.orbit(null, null, 150); await sleep(9000); __world.tick(200); out.push(row('wheeled'));
    return out.join('\n');
  })();
})()
