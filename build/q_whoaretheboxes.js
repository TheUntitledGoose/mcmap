(() => {
  const w = window.__world, out = [];
  // scan a coarse grid over the frame and report, per hit, the layer, the world Y and the vertex colour
  for (let y = 200; y <= 340; y += 35) for (let x = 700; x <= 1180; x += 60) {
    const h = w.pickStack(x, y, 1)[0];
    if (!h) { out.push(`${x},${y} none`); continue; }
    const c = h.vcol ? h.vcol[0].map((v) => Math.round(v * 255)) : null;
    out.push(`${x},${y} ${h.drawn} y=${h.block[1]} tile=${h.lodTile || '-'} rgb=${c ? c.join('/') : '-'}`);
  }
  return out.join('\n');
})()
