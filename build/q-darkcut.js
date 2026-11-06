window.__snap = (stage) => {
  const s = __world.state;
  return JSON.stringify({ stage, caves: s.cavesOn, cut: s.darkcut, verts: s.verts,
    detailVerts: s.detailVerts, chunks: s.chunks, darkFaces: s.mesh.darkCulled,
    meshMs: s.meshMs, meshMax: s.meshMax, shell: s.shellVerts, fps: +s.fps.toFixed(1) });
};
'snap defined';
