// What did we actually draw at these screen pixels? Raycast the scene and name the block state
// plus the texture each hit quad samples. Used to tell "weird colour" from "wrong texture".
(() => {
  const pts = [[1180, 140], [1150, 200], [450, 140], [340, 240], [640, 400], [700, 380], [240, 380], [520, 520]];
  return pts.map(([x, y]) => {
    const h = __world.pickState(x, y);
    if (!h) return { x, y, hit: null };
    return { x, y, block: h.block, pass: h.pass, state: h.state, tex: h.quads && h.quads.map((q) => q.id) };
  });
})()
