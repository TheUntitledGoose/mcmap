// Compact report card for the walk probe.
// Usage: node tools/browser-probe.mjs ... --eval-file build/q_walk.js 2>&1 | node build/walk_parse.cjs
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const m = raw.match(/^eval #\d+ \(\d+ chars\) => ?([^\n]*)([\s\S]*?)(?=^page state:|^screenshot:|^console:|^errors \(|^cpu: )/m);
  if (!m) { console.log('no result in output:\n' + raw.slice(-1200)); process.exit(1); }
  let d = JSON.parse((m[1] + m[2]).trim());
  if (typeof d === 'string') d = JSON.parse(d);
  const line = (k, v) => console.log(k.padEnd(14), typeof v === 'object' ? JSON.stringify(v) : v);
  line('parsed', d.parsed);
  line('invariants', d.invariants);
  line('eye', d.eye);
  line('move', d.move);
  line('V toggle', d.orbit);
  line('settle', d.settle);
  for (const [name, p] of Object.entries(d.phases ?? {})) {
    line(` ${name} n=${p.n}`, `${JSON.stringify(p.dtMs)} work ${JSON.stringify(p.workMs)}`);
    line('  buckets', p.bucketTotalsMs);
  }
  line('worst', (d.worstFrames ?? []).map((f) => `${f.dt}ms ${f.phase} [${f.top.join(' ')}]`).join('  '));
  line('fps', { walking: +d.fpsDuringWalk.toFixed(0), settled: +d.fpsSettled.toFixed(0) });
  // A throw inside frameBody takes the rest of that frame with it - the render included - and the
  // viewer keeps running, so a run on a throwing page looks healthy. It must be 0.
  line('frameErrors', d.frameErrors);
  if (d.frameError) line('lastFrameError', d.frameError);
  line('picture', d.picture);
  line('data', d.data);
  line('draw', d.draw);
  const en = raw.match(/^errors \((\d+)/m);
  const bad = (raw.match(/^ {2,}(error|log): .*$/gm) ?? []).filter((s) => !/favicon/.test(s));
  line('pageErrors', `${(en ? +en[1] : 0)} total, ${(bad.length ? bad.length + ' excluding favicon' : 'none but favicon')}`);
  for (const e of bad.slice(0, 3)) console.log('    ' + e.trim());
});
