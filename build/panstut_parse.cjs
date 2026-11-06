// Parse the stutter probe output into a compact report card.
// Usage: node tools/browser-probe.mjs ... --eval-file build/q_panstut.js 2>&1 | node build/panstut_parse.cjs
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d;
  // The probe tool prints `eval #N (chars) =>` followed by JSON.stringify(value, null, 1), then a
  // `page state:` block. Take the block between them.
  const m = raw.match(/^eval #\d+ \(\d+ chars\) => ?([^\n]*)([\s\S]*?)(?=^page state:|^screenshot:|^console:|^errors \(|^cpu: \d|^cpu: )/m);
  if (!m) { console.log('no result in output:\n' + raw.slice(-1200)); process.exit(1); }
  const text = (m[1] + m[2]).trim();
  d = JSON.parse(text);
  if (typeof d === 'string') d = JSON.parse(d);
  const line = (k, v) => console.log(k.padEnd(13), typeof v === 'object' ? JSON.stringify(v) : v);
  line('parsed', d.parsed);
  line('frames', d.framesSampled);
  line('detail', { built: (d.counters.settled.meshBuilds ?? 0) - (d.counters.before.meshBuilds ?? 0),
    chunksHeld: d.counters.settled.chunks, avgWorkerMeshMs: d.counters.settled.meshAvgMs,
    msPerBuild: +(((d.counters.settled.meshTotalMs ?? 0) - (d.counters.before.meshTotalMs ?? 0)) /
      Math.max(1, (d.counters.settled.meshBuilds ?? 0) - (d.counters.before.meshBuilds ?? 0))).toFixed(1) });
  line('panWallS', d.panWallS);
  line('settleS', d.settleAfterPanS + (d.settleNot ? ' still: ' + d.settleNot : ''));
  line('dtMs', d.frameDtMs);
  line('dt over', { '33ms': d.over33ms, '50ms': d.over50, '100ms': d.over100 });
  line('PAN dtMs', d.panDtMs);
  line('busyN', d.busyFrames);
  line('busyDtMs', d.busyDtMs);
  line('busyWork', d.busyWorkMs);
  line('bucketMs', d.bucketTotalsMs);
  line('share%', d.bucketShare);
  line('worst', d.worstFrames);
  line('gpu', d.gpu);
  if (d.patchSeries) line('sweep[s,q,cuts,tested,deferred]', d.patchSeries.map((r) => r.join('/')).join(' '));
  const c = d.counters;
  line('patch', { tested: (c.settled.patchTested ?? 0) - (c.before.patchTested ?? 0),
    deferred: (c.settled.patchDeferred ?? 0) - (c.before.patchDeferred ?? 0),
    inlineCuts: (c.settled.patchCuts ?? 0) - (c.before.patchCuts ?? 0),
    firstMeshes: (c.settled.patchCutsNew ?? 0) - (c.before.patchCutsNew ?? 0),
    reCuts: (c.settled.patchCutsChanged ?? 0) - (c.before.patchCutsChanged ?? 0),
    workerCuts: (c.settled.workerCuts ?? 0) - (c.before.workerCuts ?? 0),
    msAvg: { cut: c.settled.cutMs, job: c.settled.jobMs, sig: c.settled.sigMs },
    queueLeft: c.settled.patchQueue, patches: c.settled.patches, retired: c.settled.retired,
    verts: c.settled.verts, drawn: c.settled.drawn });
});
