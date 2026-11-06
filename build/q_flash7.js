// Does the far view still change its own mind while the camera *moves*, as it does when a user pans?
// Sample per patch tier list at each step of a stepped pan, and count A->B->A reversals: a patch whose
// tier returns to what it was two steps ago is flickering, whatever its average looks like.
const w = window.__world, out = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let prev = null, prev2 = null, prevRung = null;
const [sx, , sz] = w.state.target;
for (let step = 0; step < 8; step++) {
  // A drag: the orbit target walks sideways, so new ground arrives at one edge and leaves at the other.
  w.go(sx + step * 45, 110, sz + step * 20);
  await sleep(900);
  w.tick(10);
  const st = w.state, d = w.lodDiag(), g = w.gridEst();
  const t = st.shellTiersLive.slice();
  let rev = 0, chg = 0;
  if (prev && prev.length === t.length) {
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== prev[i]) chg++;
      if (prev2 && prev2.length === t.length && t[i] === prev2[i] && t[i] !== prev[i]) rev++;
    }
  }
  let rungRev = 0;
  if (prevRung) for (const k of Object.keys(d.rung)) if ((prevRung[k] | 0) !== (d.rung[k] | 0)) rungRev++;
  out.push(`step${step} t${t.length} chg ${chg} rev ${rev} | rung ${JSON.stringify(d.rung)} rungChg ${rungRev}`
    + ` drawn ${d.drawn}/${d.held} gaps ${d.gaps} lodVerts ${d.verts}`
    + ` | fps ${st.fps.toFixed(1)} verts ${st.verts} scale ${g.costScale} boost ${g.floorBoost} dirty ${g.dirty}`);
  prev2 = prev; prev = t; prevRung = { ...d.rung };
}
return `href ${location.href}\n` + out.join('\n');
