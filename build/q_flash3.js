// Per-tile rung decisions across two LOD passes at a still camera. If the same (rx,rz) wants one rung
// on one pass and another on the next, the rung chooser is the flicker; `px` says whether the geometry
// moved under it or the decision moved by itself.
const w = window.__world, out = [];
for (let i = 0; i < 4; i++) {
  const d = w.lodDiag();
  const map = new Map((d.picks ?? []).map((p) => [`${p.rx},${p.rz}`, p]));
  out.push({ i, tgt: (w.state.target ?? [0, 0, 0]).map((v) => +v.toFixed(1)), rung: d.rung, verts: d.verts, map });
  await new Promise((r) => requestAnimationFrame(() => r()));
  w.tick(40);
}
const [a, b] = [out[0], out[out.length - 1]];
const lines = [];
for (const [k, p] of a.map) {
  const q = b.map.get(k);
  if (q && q.want !== p.want) lines.push(`${k} px ${p.px}->${q.px} held ${p.held}->${q.held} want ${p.want}->${q.want} avail ${p.avail}->${q.avail} spent ${p.spent}->${q.spent}`);
}
lines.push(`heldTotal ${a.verts}->${b.verts} budget ${a.rung ? '' : ''} picks ${a.map.size}/${b.map.size}`);
lines.push(`sample A: ${[...a.map.values()].slice(0, 8).map((p) => `${p.rx},${p.rz} px${p.px} h${p.held}->${p.want}`).join(' ')}`);
lines.push(`sample B: ${[...b.map.values()].slice(0, 8).map((p) => `${p.rx},${p.rz} px${p.px} h${p.held}->${p.want}`).join(' ')}`);
return lines.join('\n');
