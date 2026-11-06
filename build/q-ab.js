(async () => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const row = (tag) => {
    const q = __world.state;
    return `${tag} dist=${Math.round(q.dist)} detailR=${q.detailRadius} dMesh=${q.detailMeshes}` +
      ` detailVerts=${q.detailVerts} shellVerts=${q.shellVerts} ovVerts=${q.ovVerts}` +
      ` total=${q.verts} held=${q.chunks} bytes=${Math.round(q.bytesHeld / 1e6)}MB` +
      ` render=${__world.renderMs()}ms err=${q.frameError}`;
  };
  const out = [];
  for (const d of [40, 300, 1500, 26000]) {
    __world.orbit(0.55, 0.05, d); await sleep(8000); __world.tick(200);
    out.push(row(`d=${d}`));
  }
  return out.join('\n');
})()
