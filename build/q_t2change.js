// Timeline v3's second name column exists for ONE reason: the block-change class (36,787 overworld rows,
// 35,581 of them grass_block -> dirt from tilling/paths). Walk the playhead across such a row and read
// the voxel state the undo would write, on a voxel whose only logged change is that one row.
const w = window.__world;
const out = {};
for (let i = 0; i < 240 && !w.time().tl; i++) await new Promise((r) => setTimeout(r, 250));
const raf = () => new Promise((r) => requestAnimationFrame(r));
const dim = 'minecraft:overworld';
const vox = { x: -45, y: 63, z: -126 };                       // today: minecraft:dirt
const cx = Math.floor(vox.x / 16), cz = Math.floor(vox.z / 16);
const packedFor = (x, y, z) => (x & 15) | ((z & 15) << 4) | (((y + 4096) & 0x1fff) << 8);
const key = packedFor(vox.x, vox.y, vox.z);

const got = await (await fetch(`/ledger/rows?dim=${dim}&cx=${cx}&cz=${cz}&cls=0&player=0&limit=500`)).json();
const mine = (got.rows || []).filter((r) => r.x === vox.x && r.y === vox.y && r.z === vox.z)
  .sort((a, b) => a.t - b.t);
const base = w.time().base;
out.rowsAtVoxel = mine.map((r) => ({
  t: r.t, kind: r.cls_name, block: r.block ?? r.was ?? null,
  sec: Math.floor(r.t / 1000) - base,
}));

// The replay's own view of this voxel, and how many rows of each class the cell holds.
const idx = w.timeVoxelIndex();
const cell = w.ledgerCellAt().get(`${cx},${cz}`);
out.cell = cell;
out.replayRowsForVoxel = (idx?.get(cell * 2097152 + key) ?? []).length;

const stateAtVoxel = () => {
  const e = w.histEditsOf(cx, cz);
  if (!e) return { stamp: null, state: null };
  for (let i = 0; i < e.edits.length; i += 2) {
    if (e.edits[i] === key) {
      return { stamp: e.stamp, state: e.edits[i + 1], edits: e.edits.length / 2, unknown: e.unknown };
    }
  }
  return { stamp: e.stamp, state: 'not edited', edits: e.edits.length / 2, unknown: e.unknown };
};

const seek = async (sec) => {
  w.timeGoto(sec);
  w.histSync(true);
  await raf(); await raf();
  return { asked: sec, sec: w.time().sec, ...stateAtVoxel() };
};

const t0 = Math.floor(mine[0].t / 1000) - base;
out.changeSec = t0;
out.walk = [];
for (const d of [-3600, -60, -2, -1, 0, 1, 60, 3600]) out.walk.push({ d, ...(await seek(t0 + d)) });

// The whole-dimension bill for modelling the class: at the far end of the undo (playhead at the start of
// the log) how many voxels get rewritten, and how many of those come from a change row.
w.timeSeekRow(0);
w.histSync(true);
await raf(); await raf();
out.totals = w.histTotals();
const h = w.histStats();
out.hist = { marked: h.marked, buildTotal: h.buildTotal, workerPatches: h.workerPatches,
  workerPatchTotalMs: h.workerPatchTotalMs, syncMs: h.syncMs, limit: h.limit, err: h.err };
out.detailVerts = w.state.detailVerts ?? w.state.verts;
out.storeToday = w.at(vox.x, vox.y, vox.z);
out.note = w.histNote();
out.errors = { page: w.pageErrors?.() ?? null };
return out;
