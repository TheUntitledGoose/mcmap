// Force the race that leaves a coarse plate over fine terrain: the far layer is cut while no
// full-resolution chunk exists yet, and the detail ring is switched on afterwards.
__world.tick(12, 0.05);
const before = { detail: __world.state.detailMeshes, shellVerts: __world.state.shellVerts };
await new Promise((r) => setTimeout(r, 1500));
__world.set('radius', 12);
await new Promise((r) => setTimeout(r, 9000));
__world.tick(20, 0.05);
await new Promise((r) => setTimeout(r, 2000));
__world.tick(10, 0.05);
document.body.classList.add('hidehud');
for (const el of document.querySelectorAll('.panel,#hud,#help')) el.style.display = 'none';
return JSON.stringify({
  before,
  detail: __world.state.detailMeshes,
  marks: __world.gridEst().detailMarks,
  dirty: __world.gridEst().dirty,
  shellVerts: __world.state.shellVerts,
  lodVerts: __world.state.lodVerts,
  verts: __world.state.verts,
  fps: +__world.state.fps.toFixed(1),
});
