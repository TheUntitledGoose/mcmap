// Why is the baked layer not on screen? Everything the handover decision reads, in one line.
return {
  href: location.search,
  s: (() => { const x = __world.state; return { lodOn: x.lodOn, avail: x.lodAvail, tiles: x.lodTiles, verts: x.lodVerts, gaps: x.lodGaps, err: x.lodError, cap: x.lodCap, ovOn: x.ovOn, ovCells: x.ovCells, dist: x.dist }; })(),
  d: __world.lodDiag(),
};
