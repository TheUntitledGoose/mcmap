// Read a q_fps log: one line per state, plus the tail diagnostics blob.
const t = require('fs').readFileSync(process.argv[2], 'utf8');
const pick = (o) => JSON.stringify({
  fps: o.fps, medFrameMs: o.medFrameMs, p95FrameMs: o.p95FrameMs, calls: o.calls,
  trisGpu: o.trisGpu, progs: o.progs, gpuMs: o.gpuMs, cpuRenderMs: o.cpuRenderMs, res: o.res,
  verts: o.verts, lodHeld: o.lodHeld, lodTiles: o.lodTiles, lodVerts: o.lodVerts,
  lodHideOn: o.lodHideOn, lodSkip: o.lodSkip, lodSkipVerts: o.lodSkipVerts,
  painted: o.painted, clipOn: o.clipOn, cov: o.cov, shellPatches: o.shellPatches,
  detailChunks: o.detailChunks, skinR: o.skinR, farR: o.farR, people: o.people, drawn: o.drawn,
});
for (const l of t.split(/\r?\n/)) {
  const m = l.match(/^log: FPS (\S+) (\{.*\})$/) || l.match(/^FPS (\S+) (\{.*\})$/);
  if (m) console.log(m[1].padEnd(12), pick(JSON.parse(m[2])));
}
const mm = t.match(/FPSPROF (\{.*\})/);
if (mm) {
  const o = JSON.parse(mm[1]);
  if (o.hideDiag) {
    console.log('hideDiag', JSON.stringify({
      hideOn: o.hideDiag.hideOn, held: o.hideDiag.held, drawnTiles: o.hideDiag.drawn,
      hiddenTiles: o.hideDiag.hiddenTiles, hiddenVerts: o.hideDiag.hiddenVerts,
      verts: o.hideDiag.verts, paintedPatches: o.hideDiag.paintedPatches,
      cov: o.hideDiag.cov, anchor: o.hideDiag.anchor, clipOn: o.hideDiag.clipOn,
    }), 'stateVerts', o.hideVerts);
  }
  console.log('errs', JSON.stringify(o.errs), 'res', JSON.stringify(o.res));
  console.log('profCpu', JSON.stringify(o.prof?.window ?? o.prof?.total));
}
const e = t.match(/(page error|Uncaught|not defined|TypeError)[^\n]*/);
if (e) console.log('ERRLINE', e[0].slice(0, 240));
