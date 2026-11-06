(() => {
  // Baseline table for PLAN 7.2 step 0: how much of what we draw is full-res detail,
  // as a function of eye distance. Returns a string: the probe prints eval results verbatim.
  const one = (tag) => {
    const q = __world.state, sq = __world.stateQuads();
    return `${tag} dist=${Math.round(q.dist)} ` +
      `detailChunks=${q.chunks} detailMeshes=${sq.meshes} detailVerts=${sq.verts} ` +
      `shellVerts=${q.shellVerts} ovVerts=${q.ovVerts} totalVerts=${q.verts} ` +
      `drawn=${q.drawn} fps=${Math.round(q.fps)} err=${q.frameError}`;
  };
  const out = [];
  __world.orbit(0.55, null, 60); __world.tick(60); out.push(one('dist60'));
  __world.orbit(null, null, 300); __world.tick(90); out.push(one('dist300'));
  __world.orbit(null, null, 2000); __world.tick(90); out.push(one('dist2000'));
  __world.orbit(null, null, 26000); __world.tick(90); out.push(one('dist26000'));
  return out.join('\n');
})()
