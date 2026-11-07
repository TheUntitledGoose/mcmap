// M12 UI acceptance, one page: do the controls mount, does the index load, is the overlay actually
// drawn (renderer.info, GL's own count), do the tour buttons work, does asking about a block answer,
// and is the resolution governor bounded now.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) await raf(); };
const btn = (label) => [...document.querySelectorAll('.panel-actions button')]
  .find((b) => b.textContent.trim() === label);
const out = { url: location.href };

// ---- 1. the panel controls mounted
out.keysMissing = ['ledger', 'ledgerCls', 'ledgerWho', 'ledgerMin', 'ledgerXray']
  .filter((k) => !w.panelKeys().includes(k));
const sel = [...document.querySelectorAll('.panel-select select')];
out.selects = sel.map((s) => [s.options.length, [...s.options].slice(0, 3).map((o) => o.label)]);
out.checks = ['ledger', 'ledgerXray'].map((k) => {
  const row = [...document.querySelectorAll('.panel-row')].find((r) => r.querySelector('input[type=checkbox]')
    && r.textContent.includes(k === 'ledger' ? 'activity overlay' : 'see through terrain'));
  return row ? [row.textContent.trim().slice(0, 40), !!row.querySelector('input').checked] : null;
});
const notes = [...document.querySelectorAll('.panel-note')].map((n) => n.textContent);
out.ledgerNote = notes.find((t) => /rows over .* touched chunks|no ledger|not asked/.test(t)) ?? null;

// ---- 2. the index loads and the overlay is drawn (GL counts, not mine)
btn('whole world').click();
await settle(60);
const i0 = { ...w.renderer.info.render };
w.setLedger(true);
await w.ledgerLoad();
await settle(20);
const i1 = { ...w.renderer.info.render };
const L = w.ledger();
out.index = { err: L.err, cells: L.cells, max: L.max, quads: L.kb ? L.quads : 0, kb: L.kb,
  fetchMs: L.fetchMs, buildMs: L.buildMs, noHeight: L.noHeight, drawn: L.drawn };
const g = w.scene.children.find((c) => c.name === 'ledger');
out.mesh = g ? g.children.map((c) => ({ n: c.name, verts: c.geometry.attributes.position.count,
  idx: c.geometry.index ? c.geometry.index.count : 0, wide: c.geometry.index.array.constructor.name,
  side: c.material.side, depthTest: c.material.depthTest })) : null;
out.drawn = { calls: i1.calls - i0.calls, tris: i1.triangles - i0.triangles, expectTris: 2 * L.quads };

// ---- 3. the tour button (the one that did nothing before)
btn('hotspots').click();
await settle(30);
const card = document.querySelector('.lcard');
out.tour = { card: !!card, rows: document.querySelectorAll('.lcard-row').length,
  head: card?.querySelector('.lcard-head')?.textContent?.trim().slice(0, 70),
  top: w.ledger().top?.slice(0, 3), pins: w.ledger().pins, target: w.state.target, pill: w.state.msg ?? null };
out.dist = w.state.dist;

// 3b. and the card's own rows are buttons: the fourth one has to move the camera to the fourth
// loudest chunk. (The user's complaint was that these buttons did nothing at all.)
const want = w.ledger().top[3];
const before = [...w.state.target];
document.querySelectorAll('.lcard-row')[3].click();
await settle(20);
out.rowClick = { want, before, after: [...w.state.target], moved: w.state.target[0] !== before[0] || w.state.target[2] !== before[2],
  nearCentre: Math.abs(w.state.target[0] - (want[0] * 16 + 8)) <= 8
    && Math.abs(w.state.target[2] - (want[1] * 16 + 8)) <= 8,
  dist: Math.round(w.state.dist) };

// ---- 4. "who placed this": ask about a real row's block in the loudest chunk
const [hx, hz] = w.ledger().top[0];
const res = await fetch(`/ledger/rows?dim=${encodeURIComponent(w.dim())}&cx=${hx}&cz=${hz}&limit=50`).then((r) => r.json());
const row = res.rows[0];
out.rowsFetch = { total: res.total, got: res.rows.length, first: [row.x, row.y, row.z, row.cls, row.player, row.block] };
await w.ledgerAsk(row.x, row.y, row.z);
await settle(4);
out.ask = { cardRows: w.ledger().cardRows, cardTotal: w.ledger().cardTotal,
  domRows: document.querySelectorAll('.lcard-row').length,
  line: document.querySelector('.lcard-row')?.textContent?.trim(),
  sub: document.querySelector('.lcard-sub')?.textContent?.trim().slice(0, 120) };

// ---- 5. a filter change is a rebuild, not a second download
const kb0 = w.ledger().kb;
w.set('ledgerMin', 32);
await settle(4);
out.filter = { cells: w.ledger().cells, quads: w.ledger().quads, dropped: w.ledger().dropped,
  sameBytes: w.ledger().kb === kb0, buildMs: w.ledger().buildMs };
w.set('ledgerCls', 2);
w.set('ledgerMin', 1);
await settle(4);
out.filterPlace = { cells: w.ledger().cells, max: w.ledger().max, quads: w.ledger().quads };

// ---- 6. the governor on a signal that flips: it must run out of ways to move, not resize forever
w.resetRes();
const c0 = w.res().changes;
const tl = [];
const steps = [[0, 40], [3000, 40], [6000, 40], [9000, 40], [12000, 40],
  [15000, 3], [18000, 3], [21000, 3], [24000, 40], [27000, 40],
  [30000, 3], [33000, 3], [36000, 3], [39000, 40], [42000, 40],
  [45000, 40], [48000, 3], [51000, 40]];
for (const [t, ms] of steps) {
  const r = w.tuneResNow(ms, true, performance.now() + 100000 + t);
  tl.push([t, ms, r.rung, r.auto, r.flips, r.locked]);
}
out.governor = { reallocs: w.res().changes - c0, ladder: w.res().ladder, steps: tl,
  locked: w.res().locked, flips: w.res().flips, px: w.renderer.info ? null : null };
w.resetRes();
w.setLedger(false);
return out;
