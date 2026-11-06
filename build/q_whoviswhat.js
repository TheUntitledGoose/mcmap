// who owns the triangles and the draw calls at a whole-world framing
(() => {
  const s = window.__world.state;
  const objs = { detail: 0, shell: 0, lod: 0, other: 0, detailV: 0, shellV: 0, lodV: 0 };
  window.__world.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const n = o.geometry?.attributes?.position?.count ?? 0;
    const tag = (o.userData && o.userData.pass) || o.name || '';
    const t = String(tag).toLowerCase();
    if (t.includes('lod')) { objs.lod++; objs.lodV += n; }
    else if (t.includes('shell') || t.includes('patch')) { objs.shell++; objs.shellV += n; }
    else if (t.includes('detail') || t.includes('chunk')) { objs.detail++; objs.detailV += n; }
    else { objs.other++; }
  });
  return JSON.stringify({
    dist: s.dist, verts: s.verts, drawn: s.drawn, detailMeshes: s.detailMeshes,
    detailVerts: s.detailVerts, shellPatches: s.shellPatches, shellVerts: s.shellVerts,
    lodTiles: s.lodTiles, lodVerts: s.lodVerts, demoted: s.demoted, chunks: s.chunks,
    named: objs,
  });
})()
