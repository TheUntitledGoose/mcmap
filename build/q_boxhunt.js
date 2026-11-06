// Which layer paints a grid of pixels at this framing?
(function () {
  const w = __world, n = {}; const rows = [];
  for (let sy = innerHeight * 0.30; sy < innerHeight * 0.96; sy += innerHeight * 0.06) {
    for (let sx = innerWidth * 0.08; sx < innerWidth * 0.92; sx += innerWidth * 0.08) {
      const s = w.pickStack(sx, sy, 1);
      if (!s || !s.length) { n.miss = (n.miss || 0) + 1; continue; }
      const h = s[0];
      n[h.drawn] = (n[h.drawn] || 0) + 1;
      if (h.drawn !== 'detail') rows.push(`${sx | 0},${sy | 0} ${h.drawn} y${h.point[1] | 0} blk${h.block} tile${h.lodTile || ''}`);
    }
  }
  return JSON.stringify({ counts: n, nonDetail: rows.slice(0, 16), nRows: rows.length });
})();
