(() => {
  const st = __world.state;
  // Walk outward from the orbit target along +x and read which far-grid cell each chunk gets.
  // Before this fix the answer jumped to the coarsest cell past a fixed chunk radius no matter how
  // close the camera was, which is what drew giant flat plates an arm's length from the lens.
  const cx0 = Math.floor(st.target[0] / 16), cz0 = Math.floor(st.target[2] / 16);
  const ring = [];
  for (const d of [0, 4, 8, 12, 16, 24, 32, 48, 64, 96]) {
    const a = __world.lodOf((cx0 + d) * 16 + 8, (cz0 + 8) * 16 + 8);
    ring.push({ d, cell: a.cell, held: a.shell });
  }
  // Same walk going backwards, i.e. towards and past the camera: the near foreground.
  const side = [];
  for (const d of [0, 8, 16, 24, 32, 48]) {
    const a = __world.lodOf((cx0 - d) * 16 + 8, (cz0 + 8) * 16 + 8);
    side.push({ d, cell: a.cell, held: a.shell });
  }
  return { dist: st.dist, maxZoom: st.maxZoom, skinRadius: st.skinRadius, lod: st.shellTiers,
    tiersLive: [...new Set(st.shellTiersLive)],
    chunks: st.chunks, verts: st.verts, drawn: st.drawn, shellVerts: st.shellVerts,
    shellPatches: st.shellPatches, shellHeld: st.shellHeld, ovCells: st.ovCells,
    meshWait: st.meshWait, shellMs: st.shellMs, shellMsMax: st.shellMsMax, fps: st.fps, err: st.frameError, near: st.near, far: st.far,
    ring, side };
})()
