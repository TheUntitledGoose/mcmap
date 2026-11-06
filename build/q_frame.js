// What paints this frame, and how much of it is a coarse plate?
// A grid over the *real* viewport (pickStack takes CSS pixels), bucketed by the layer that drew
// the pixel, with the world column and the vertex colour for anything suspiciously brown.
(() => {
  const w = window.__world;
  const W = innerWidth, H = innerHeight;
  const NX = 26, NY = 15;
  const by = {}, rows = [], brown = [];
  for (let iy = 0; iy < NY; iy++) {
    for (let ix = 0; ix < NX; ix++) {
      const sx = Math.round(W * (ix + 0.5) / NX), sy = Math.round(H * (iy + 0.5) / NY);
      const h = w.pickStack(sx, sy, 1)[0];
      if (!h) { by.sky = (by.sky || 0) + 1; continue; }
      const c = h.vcol ? h.vcol[0].map((v) => Math.round(v * 255)) : [0, 0, 0];
      const key = h.drawn + (h.lodCell !== undefined ? `@${h.lodCell}` : '');
      by[h.drawn] = (by[h.drawn] || 0) + 1;
      // brown-and-tall: a face whose colour is brown and whose column stands well above ground
      if (c[0] > 60 && c[0] > c[1] * 1.3 && c[1] > c[2] * 1.2) {
        brown.push(`${sx},${sy} ${h.drawn} tile=${h.lodTile || '-'} y=${h.block[1]} at ${h.block[0]},${h.block[2]} rgb=${c.join('/')}`);
      }
      rows.push(`${sx},${sy} ${h.drawn} y=${h.block[1]}`);
    }
  }
  const st = w.state;
  return `viewport ${W}x${H} dpr ${devicePixelRatio}
counts ${JSON.stringify(by)}
brown ${brown.length}:
${brown.slice(0, 14).join('\n')}
fps ${st.fps} verts ${st.verts} lodVerts ${st.lodVerts} shells ${st.shells} patches ${st.patches}`;
})()
