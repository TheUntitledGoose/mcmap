// boot + panel + API check for the M12 ledger UI. The proof it is really drawn is renderer.info:
// one extra draw call and 2 triangles per decal quad, counted by GL, not by my own bookkeeping.
const w = window.__world;
const raf = () => new Promise((res) => requestAnimationFrame(res));
const settle = (n) => { for (let i = 0; i < n; i++) { w.tick(); } };
const out = {};
out.keys = w.panelKeys();
out.missing = ['ledger', 'ledgerCls', 'ledgerWho', 'ledgerMin', 'ledgerXray'].filter((k) => !out.keys.includes(k));
out.presets = w.presets().map((x) => x.label);
out.heads = [...document.querySelectorAll('#ui h2, #ui .head, .panel .head, body .head')]
  .map((e) => e.textContent.trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 30);
out.note = w.ledgerNote();
out.metaAvail = w.ledger().meta?.available ?? null;
out.metaDims = (w.ledger().meta?.dims ?? []).map((d) => [d.dimId, d.rows, d.cells]);
await w.ledgerLoad();
settle(2);
out.afterLoad = w.ledger();
out.note2 = w.ledgerNote();
const info0 = { ...w.renderer.info.render };
const t0 = performance.now();
w.setLedger(true);
settle(4);
out.on = w.ledger();
out.onMs = +(performance.now() - t0).toFixed(1);
const info1 = { ...w.renderer.info.render };
out.draw = { before: info0, after: info1, calls: info1.calls - info0.calls, tris: info1.triangles - info0.triangles };
const g = w.scene.children.find((c) => c.name === 'ledger');
out.ledgerGroup = g ? g.children.map((c) => ({ name: c.name, type: c.type,
  verts: c.geometry?.attributes?.position?.count ?? null, idx: c.geometry?.index?.count ?? null,
  idxType: c.geometry?.index?.array?.constructor?.name ?? null, idxMax: c.geometry?.index
    ? c.geometry.index.array[c.geometry.index.array.length - 1] : null,
  depthTest: c.material?.depthTest, order: c.renderOrder, culled: c.frustumCulled })) : null;
if (g && g.children[0]) {
  const m = g.children[0];
  m.geometry.computeBoundingSphere();
  out.sphere = { c: m.geometry.boundingSphere.center.toArray().map(Math.round), r: Math.round(m.geometry.boundingSphere.radius) };
}
// a filter change must be a rebuild, not a second download
const before = { ...w.ledger() };
w.panel().set('ledgerMin', 8);
settle(2);
out.afterFloor = { ...w.ledger(), sameBytes: w.ledger().kb === before.kb };
// X-ray off should actually hide decals behind a hill: same geometry, different depthTest
w.panel().set('ledgerXray', false);
settle(2);
out.xrayOff = { depthTest: g.children.map((c) => c.material?.depthTest), drawn: w.ledger().drawn };
w.panel().set('ledgerXray', true);
const st = w.state;
out.frame = { fps: st.fps, verts: st.verts, drawn: st.drawn, retired: st.retired };
return out;
