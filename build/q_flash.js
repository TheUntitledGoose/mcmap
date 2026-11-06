// Does the far grid settle, or does it re-cut forever? A static camera with no input must stop
// meshing; if `cuts` keeps climbing and `costScale` walks up and down, the budget loop is in a
// limit cycle and the far view flickers between two tiers.
// The probe wraps a body containing `await` in an async function, so `return` here is legal.
const w = window.__world, out = [];
for (let i = 0; i < 6; i++) {
  const g = w.gridEst();
  out.push(`${i}: scale ${g.costScale} boost ${g.floorBoost} peak ${g.peak} held ${g.held}`
    + ` cuts ${g.cuts} dirty ${g.dirty}`
    + ` verts ${g.verts} vpc ${g.vpc} px ${g.cellPx.toFixed(2)} tiers ${[...new Set(g.tiers)].sort().join('/')}`);
  await new Promise((r) => requestAnimationFrame(() => r()));
  w.tick(40);
}
const g = w.gridEst();
out.push(`final: cuts ${g.cuts} dirty ${g.dirty} verts ${g.verts}`);
return out.join('\n');
