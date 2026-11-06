(async () => {
  const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
  const row = (tag) => {
    const q = __world.state;
    return `${tag} held=${q.chunks} payloadR=${q.payloadRadius} detailR=${q.detailRadius}` +
      ` detailMeshes=${q.detailMeshes} detailVerts=${q.detailVerts} demoted=${q.demoted}` +
      ` inflight=${q.inflight} queued=${q.queued} missing=${q.missing} bytes=${Math.round(q.bytesHeld / 1e6)}MB` +
      ` shellVerts=${q.shellVerts} total=${q.verts} err=${q.frameError}`;
  };
  const out = [];
  __world.orbit(0.55, null, 60); await sleep(9000); __world.tick(150);
  out.push(row('close   '));
  __world.orbit(null, null, 26000); await sleep(9000); __world.tick(150);
  out.push(row('far     '));
  __world.orbit(null, null, 60); await sleep(9000); __world.tick(200);
  out.push(row('back    '));
  return out.join('\n');
})()
