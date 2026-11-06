(() => {
  // M5.7 acceptance table: full-res detail must collapse with distance, and the coarse layers must
  // cover what it leaves behind.
  const one = (tag) => {
    const q = __world.state;
    return `${tag} dist=${Math.round(q.dist)} detailR=${q.detailRadius} payloadR=${q.payloadRadius}` +
      ` detailMeshes=${q.detailMeshes} detailVerts=${q.detailVerts} demoted=${q.demoted}` +
      ` shellVerts=${q.shellVerts} ovVerts=${q.ovVerts} total=${q.verts} drawn=${q.drawn}` +
      ` held=${q.chunks} bytes=${Math.round(q.bytesHeld / 1e6)}MB fps=${Math.round(q.fps)} err=${q.frameError}`;
  };
  const out = [];
  for (const [d, t] of [[60, 'd60'], [300, 'd300']]) {
    __world.orbit(0.55, null, d); __world.tick(40); out.push(one(t));
  }
  return out.join('\n');
})()
