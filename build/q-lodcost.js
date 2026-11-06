(async () => {
  // Real GPU render cost, measured around renderer.render rather than from fps: headless Chrome's
  // frame pacing varies (the same scene reported 165 fps and 32 fps in two runs), so fps is not a
  // measurement. This is the M5.7 acceptance: the same frame, with and without full-res detail.
  const r = __world.renderer, s = __world.scene, c = __world.camera;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let frames = 0;
  const pump = (n) => { __world.tick(n); frames += n; };
  const time = (tag, n = 30) => {
    r.render(s, c);                                  // warm the pipeline once
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.render(s, c);
    const ms = (performance.now() - t0) / n;
    const q = __world.state;
    return `${tag} render=${ms.toFixed(2)}ms detailR=${q.detailRadius} detailMeshes=${q.detailMeshes}` +
      ` detailVerts=${q.detailVerts} demoted=${q.demoted} shellVerts=${q.shellVerts}` +
      ` ovVerts=${q.ovVerts} total=${q.verts} held=${q.chunks} bytes=${Math.round(q.bytesHeld / 1e6)}MB` +
      ` workers=${q.workers}/${q.workerReady} loop=${q.loopFrames} err=${q.frameError}`;
  };
  const out = [];
  __world.orbit(0.55, null, 26000); await sleep(6000); pump(120);
  out.push(time('far 26km, detail OFF (new default)'));
  __world.panel().set('detailsharp', 0.25);          // old behaviour: full res whatever the zoom
  await sleep(12000); pump(240);
  out.push(time('far 26km, detail ON (old behaviour)'));
  __world.panel().set('detailsharp', 1); pump(60);
  __world.orbit(null, null, 60); await sleep(8000); pump(240);
  out.push(time('close 60m, detail ON'));
  __world.orbit(null, null, 1500); await sleep(8000); pump(240);
  out.push(time('mid 1.5km, detail OFF (new default)'));
  return out.join('\n');
})()
