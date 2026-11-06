// Is the hitch a *steady state* problem or a *camera-move* problem? Sit at one zoom, then pan 2.9 km
// and sample every step: fps, verts, patch counts, and the per-frame CPU split.
const st = () => JSON.stringify((s) => ({
  fps: s.fps, verts: s.verts, det: s.detailVerts, dm: s.detailMeshes, sh: s.shellVerts,
  patches: s.shellPatches, held: s.shellHeld, ov: s.ovVerts, bands: s.ovBands,
  skin: s.skinR, det_r: s.detailRadius, retired: s.retired, gpu: s.gpuMs,
}))(__world.state);
const pr = () => JSON.stringify(__world.prof());
const row = (tag) => `${tag} ${st()} ${pr()}`;
console.log(row('settled-before'));
__world.go(5900, 110, 3900); __world.orbit(null, null, 400); 'panned'
