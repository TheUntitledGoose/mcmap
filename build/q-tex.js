(async () => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (const dist of [300, 1200]) {
    __world.orbit(null, null, dist);
    await settle(2500); __world.tick(4);
    await settle(1500); __world.tick(4);
    const st = __world.state;
    const px = [];
    for (const [sx, sy] of [[540, 410], [560, 430], [580, 450], [500, 500], [620, 380]]) {
      const h = __world.pickState(sx, sy);
      px.push([sx, sy, __world.pick(sx, sy), h && h.drawn, h && h.state, h && h.vcol]);
    }
    out.push({
      dist, patches: st.shellPatches, textured: st.shellTextured, shellVerts: st.shellVerts,
      verts: st.verts, renderMs: __world.renderMs ? __world.renderMs() : null, px,
    });
  }
  return JSON.stringify(out, null, 1);
})();
