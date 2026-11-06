(() => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const kids = () => { const o = {}; __world.scene.traverse((n) => { if (n.name && n.isMesh !== undefined && n.type === 'Group') o[n.name] = n.children.length; }); return o; };
  return (async () => {
    __world.go(2976, 68, 2007); __world.orbit(0.6, 0.22, 150);
    await sleep(12000); __world.tick(250);
    const out = [];
    const q = __world.state;
    out.push(`near groups=${JSON.stringify(kids())} shellMeshes=${q.shellPatches} ovMeshes=${q.ovMeshes} ovBands=${q.ovBands} verts=${q.verts} render=${__world.renderMs()}`);
    __world.orbit(0.6, 0.5, 26000); await sleep(10000); __world.tick(200);
    const q2 = __world.state;
    out.push(`far  groups=${JSON.stringify(kids())} shellMeshes=${q2.shellPatches} ovMeshes=${q2.ovMeshes} ovBands=${q2.ovBands} verts=${q2.verts} render=${__world.renderMs()}`);
    __world.orbit(0.6, 0.22, 150); await sleep(10000); __world.tick(200);
    const q3 = __world.state;
    out.push(`back groups=${JSON.stringify(kids())} shellMeshes=${q3.shellPatches} ovMeshes=${q3.ovMeshes} ovBands=${q3.ovBands} verts=${q3.verts} render=${__world.renderMs()}`);
    return out.join('\n');
  })();
})()
