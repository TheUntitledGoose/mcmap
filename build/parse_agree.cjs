// Pull the AGREE line out of a probe log and print only what matters: the playhead the pixels were sampled
// at, the control-pair stability, the owner/painted tallies, and every disagreement with the fields that
// explain it (marker shape, sprite alpha, which layer the frame drew, and both distances).
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  console.log('--- ' + f);
  const k = t.indexOf('log: AGREE {');
  if (k < 0) { console.log('  (no AGREE line yet)'); continue; }
  const s = t.indexOf('{', k);
  const e = t.indexOf('\n', s);
  let o;
  try { o = JSON.parse(t.slice(s, e)); } catch (err) { console.log('  parse fail', err.message); continue; }
  console.log('  ' + JSON.stringify({ playhead: o.playhead, stability: o.stability, restore: o.restore,
    timeRestore: o.timeRestore, asked: o.asked, disagree: o.disagree, replayPixels: o.replayPixels ?? 0,
    owners: o.owners, painted: o.paintedKinds, stopped: o.stopped ?? null }));
  for (const q of o.samples) if (!q.agree) console.log('  DIS ' + JSON.stringify({
    px: q.px, o: q.owner, p: q.painted, cube: q.cube, alpha: q.alpha, paints: q.paints,
    front: q.markFront, layer: q.drawnLayer, w: q.world, mv: q.markVoxel, gb: q.ground, d: q.dists }));
}
