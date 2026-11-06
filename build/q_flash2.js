// Which layer is changing its mind? Diff the per-patch tier list and the baked rung counts between
// samples. A patch whose tier goes 2 -> 3 -> 2 -> 3 at a still camera is the flicker the user sees,
// and it is not the same bug as a baked tile swapping rungs.
const w = window.__world, out = [];
let prevT = null, prevRung = null;
for (let i = 0; i < 6; i++) {
  const st = w.state, g = w.gridEst(), d = w.lodDiag();
  const t = st.shellTiersLive.slice();
  let up = 0, down = 0;
  if (prevT && prevT.length === t.length) {
    for (let j = 0; j < t.length; j++) {
      if (t[j] > prevT[j]) up++; else if (t[j] < prevT[j]) down++;
    }
  }
  const rung = d.rung;
  let rungFlip = 0;
  if (prevRung) for (const k of Object.keys(rung)) if ((prevRung[k] | 0) !== (rung[k] | 0)) rungFlip++;
  out.push(`${i}: patchTierChg +${up}/-${down} n ${t.length} | rung ${JSON.stringify(rung)} flips ${rungFlip}`
    + ` drawn ${d.drawn}/${d.held} wanted ${d.wanted} lodVerts ${d.verts}`
    + ` | scale ${g.costScale} boost ${g.floorBoost} dirty ${g.dirty} cuts ${g.cuts}`
    + ` ovOn ${st.ovOn} underFar ${st.underFar}`);
  prevT = t; prevRung = rung;
  await new Promise((r) => requestAnimationFrame(() => r()));
  w.tick(40);
}
return out.join('\n');
