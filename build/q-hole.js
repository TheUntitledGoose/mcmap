(() => {
  // One shell chunk is confirmed missing (HUD "shellMissing 1"). If it sits in a cell next to the
  // camera that cell is not "covered", so the coarse layer paints a 64 block slab over the fine
  // terrain right there. Find it.
  const holes = [];
  for (let cz = -12; cz <= 12; cz++) {
    for (let cx = -12; cx <= 12; cx++) if (!__world.shellAt(cx, cz)) holes.push(`${cx},${cz}`);
  }
  const cells = new Set();
  for (const h of holes) {
    const [cx, cz] = h.split(',').map(Number);
    const o = __world.ovAt(cx * 16, cz * 16);
    if (o) cells.add(`${o.cell} covered=${o.covered} h=${o.h} s=${o.state}`);
  }
  const hits = [150, 260].map((y) => {
    const h = __world.pickStack(640, y, 1)[0];
    return h ? { y, dr: h.drawn, q: h.quad, p: h.point, at: __world.ovAt(h.point[0], h.point[2]), lod: __world.lodOf(h.point[0], h.point[2]) } : null;
  });
  return 'LOD8 ' + JSON.stringify({ holes: holes.length, sample: holes.slice(0, 12), cells: [...cells].slice(0, 6), hits });
})()
