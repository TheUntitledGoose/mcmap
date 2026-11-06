// is every drawn geometry a quad soup (6 verts per quad)? that is the precondition for sharing one
// index buffer across all of them instead of shipping 12.9 M verts of duplicated corners.
(() => {
  const w = window.__world;
  const byName = {};
  let soup = 0, notSoup = 0, verts = 0, idx = 0, maxCount = 0;
  w.scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const g = o.geometry;
    const n = g?.attributes?.position?.count ?? 0;
    if (!n) return;
    verts += n;
    maxCount = Math.max(maxCount, n);
    if (g.index) { idx++; return; }
    const rec = (byName[o.name || '?'] ??= { meshes: 0, verts: 0, soup: 0, odd: 0 });
    rec.meshes++; rec.verts += n;
    if (n % 6 === 0) { rec.soup++; soup++; } else { rec.odd++; notSoup++; }
  });
  return JSON.stringify({ meshes: soup + notSoup + idx, soup, notSoup, alreadyIndexed: idx,
    verts, biggestMesh: maxCount, over16bit: (() => { let k = 0; w.scene.traverse((o) => { if (o.isMesh && o.visible && (o.geometry?.attributes?.position?.count ?? 0) > 65535) k++; }); return k; })(),
    byName });
})()
