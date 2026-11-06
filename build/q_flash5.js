// Live far grid only (?nolod=1): does the budget walk change its mind at a still camera, or while the
// view is being orbited? Counts of tier changes per sample are the flicker count for that layer.
const w = window.__world, out = [];
let prev = null;
const sample = async (tag) => {
  const g = w.gridEst();
  const t = g.tiers;
  let chg = 0;
  if (prev && prev.length === t.length) for (let j = 0; j < t.length; j++) if (t[j] !== prev[j]) chg++;
  out.push(`${tag}: n ${t.length} chg ${chg} verts ${g.verts} scale ${g.costScale} boost ${g.floorBoost}`
    + ` peak ${g.peak ?? '-'} relax ${g.held ?? '-'} tiers ${JSON.stringify([...new Set(t)].sort())}`);
  prev = t;
  await new Promise((r) => requestAnimationFrame(() => r()));
  w.tick(30);
};
for (let i = 0; i < 3; i++) await sample(`still${i}`);
for (let i = 0; i < 4; i++) { w.orbit(i * 6, null, null); await sample(`orbit${i}`); }
for (let i = 0; i < 3; i++) await sample(`after${i}`);
return out.join('\n');
