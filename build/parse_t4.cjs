// Pull the JSON a probe printed to the page console out of a browser-probe transcript.
// The console section starts after the screenshot line, and its first record is prefixed "log: ".
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const t = fs.readFileSync(f, 'utf8');
  const m = t.match(/^console:\n([\s\S]*?)\n(errors|screenshot)/m);
  if (!m) { console.log(f, 'no console block'); continue; }
  const blob = m[1].split(String.fromCharCode(10))
    .map((l) => l.replace(/^ {2}/, '')).join(String.fromCharCode(10)).replace(/^log: /, '');
  let d;
  try { d = JSON.parse(blob); } catch (e) { console.log(f, 'parse fail', e.message, blob.slice(0, 200)); continue; }
  console.log(f.replace(/\.txt$/, ''), JSON.stringify({
    sharp: d.settings.timeSharp, grow: d.settings.timeGrow, radius: d.settings.radius,
    terrain: d.settings.timeTerrain, detailR: d.frame.detailRadius, payloadR: d.frame.payloadRadius,
    detailMeshes: d.frame.detailMeshes, detailVerts: d.frame.detailVerts, verts: d.frame.verts,
    msToQuiet: d.msToQuiet, fpsSettled2s: d.fpsSettled2s, quiet: d.quietFrame,
    outside: d.marker.medianOutside, cornerVoxels: d.marker.medianCornerVoxels,
    split: d.splitSettled ?? d.split, hist: d.histSettled ?? d.hist, time: d.time,
  }));
}
