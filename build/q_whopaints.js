const H = innerHeight, W = innerWidth, c = {}, rows = [];
for (const fy of [0.55, 0.65, 0.75, 0.85, 0.95]) {
  for (const fx of [0.25, 0.5, 0.75]) {
    const s = __world.pickStack(Math.floor(W * fx), Math.floor(H * fy), 1);
    const h = s[0];
    const t = (h && h.type) || '-';
    c[t] = (c[t] || 0) + 1;
    rows.push([fx, fy, t, (h && h.lodTile) || '', (h && h.chunk) || '', Math.round((h && h.distance) || 0)]);
  }
}
JSON.stringify({ c, rows, detail: __world.state.detailMeshes, tiers: __world.gridEst().tiers, live: __world.gridEst().live, cov: __world.lodDiag().cov });
