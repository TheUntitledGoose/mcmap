// The mesh got rebuilt on the history key and the wall is STILL deepslate. So: is the voxel's row in
// the filtered set at all, is its edit in the list, and what value does the list ask for?
const w = window.__world;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (ms = 2500) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { await sleep(25); w.tick(2); } };
await sleep(0);

const HCX = -4, HCZ = -9, HX = -59, HY = 72, HZ = -130;
const PH_SEC = 100948;
const lx = HX - HCX * 16, lz = HZ - HCZ * 16;
const packed = ((HY + 4096) << 8) | (lz << 4) | lx;
const dec = (c) => ({ x: c & 15, y: (c >> 8) - 4096, z: (c >> 4) & 15 });

const atlas = await (await fetch('/assets/atlas.json')).json();
const name = (id) => (id ? atlas.states[id - 1]?.k ?? `id:${id}` : 'none');

w.setTimePlay(0);
w.settings.timeTiles = 0;
w.go(HX, HY, HZ);
w.orbit(w.state.yaw, 0.35, 28);
await settle(2000);
w.settings.timeTerrain = 1; w.timeGoto(PH_SEC); w.histSync(true);
await settle(3000);

const mark = w.HIST.marks.get(`${HCX},${HCZ}`);
const ed = mark?.edits ?? [];
let found = -1;
for (let i = 0; i < ed.length; i += 2) if (ed[i] === packed) { found = i; break; }
const ci = w.HIST.cellsAt.get(`${HCX},${HCZ}`);
const rows = w.HIST.byCell?.get(ci) ?? null;
const tl = w.TLAYER.tl;
const inSet = w.TLAYER.rows;                     // filtered row order (indices into tl)
const acts = {};
let onVox = [];
if (rows) {
  for (const i of rows) {
    acts[tl.action[i]] = (acts[tl.action[i]] || 0) + 1;
    if (tl.x(i) === lx && tl.z(i) === lz && tl.y(i) === HY) {
      onVox.push({ i, sec: tl.sec[i], act: tl.action[i], name: tl.nameOf(i), was: tl.wasOf(i) });
    }
  }
}
const high = [];
for (let i = 0; i < ed.length && high.length < 12; i += 2) {
  const d = dec(ed[i]);
  if (d.y >= 66) high.push(`${d.x},${d.y},${d.z}->${ed[i + 1]} ${name(ed[i + 1] === 0 ? 0 : ed[i + 1])}`);
}
const p = w.pickState(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
return {
  voxel: `${HX},${HY},${HZ} local ${lx},${HY},${lz} packed ${packed}`,
  today: w.at(HX, HY, HZ),
  editForVoxel: found < 0 ? null : { at: found / 2, value: ed[found + 1], writes: name(ed[found + 1] || w.HIST?.airId) },
  markGen: mark?.gen, edits: ed.length / 2, unknown: mark?.unknown, truncated: mark?.truncated,
  rowsInCellForChunk: rows?.length ?? null, actionsInCell: acts, rowsOnThisVoxel: onVox,
  filteredRows: w.TLAYER.rows, timeCls: w.settings.timeCls, timeLimit: w.settings.timeLimit,
  truncatedLayer: w.TLAYER.truncated, drawn: w.TLAYER.drawn, cur: w.TLAYER.cur,
  hist: { marked: w.histStats().marked, restore: w.histStats().restore, chunks: w.histStats().chunks,
    edits: w.histStats().edits, builds: w.histStats().builds, skipped: w.histStats().skipped },
  diag: w.meshDiag(HCX, HCZ),
  pick: p ? { b: p.block, s: p.state, drawn: p.drawn } : null,
  airIdGuess: w.histStats().limit, sampleHighEdits: high,
};
