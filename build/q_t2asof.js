// M12b.5: the undo must answer "what stood HERE at that moment", not "undo each later row one at a time".
// Walk the playhead across one voxel's own ledger rows and report the state the edit list would write.
// Each step forces histSync(true): a seek smaller than timeTerrainStep self-throttles, and a throttled read
// here would be measuring the previous playhead.
const w = window.__world;
const out = {};
// The timeline is a 5.6 MB fetch and a mesh build; a probe that starts before it lands would read a null
// playhead as if the replay were empty.
for (let i = 0; i < 240 && !w.time().tl; i++) await new Promise((r) => setTimeout(r, 250));
out.timelineMs = w.time().fetchMs;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const dim = 'minecraft:overworld';
const vox = { x: -45, y: 64, z: -126 };
const cx = Math.floor(vox.x / 16), cz = Math.floor(vox.z / 16);

const packedFor = (x, y, z) => (x & 15) | ((z & 15) << 4) | (((y + 4096) & 0x1fff) << 8);

// The rows that touched this voxel, from the server's point-query view (it carries exact times).
const got = await (await fetch(`/ledger/rows?dim=${dim}&cx=${cx}&cz=${cz}&cls=0&player=0&limit=600`)).json();
const mine = (got.rows || []).filter((r) => r.x === vox.x && r.y === vox.y && r.z === vox.z).sort((a, b) => a.t - b.t);
out.rowsAtVoxel = mine.map((r) => ({
  t: r.t, cls: r.cls, kind: r.cls_name, block: r.block ?? r.was ?? null,
  sec: Math.floor(r.t / 1000) - Math.floor(got.timeBaseSec ?? 1717174690),
}));

// The same rows in the browser's filtered replay (places only, as the URL sets it).
const idx = w.timeVoxelIndex();
const cell = w.ledgerCellAt().get(`${cx},${cz}`);
const key = packedFor(vox.x, vox.y, vox.z);
out.replayRowsForVoxel = (idx?.get(cell * 2097152 + key) ?? []).length;
out.cell = cell;

const stateAtVoxel = () => {
  const e = w.histEditsOf(cx, cz);
  if (!e) return { stamp: null, state: null };
  const ed = e.edits;
  for (let i = 0; i < ed.length; i += 2) if (ed[i] === key) return { stamp: e.stamp, state: ed[i + 1], edits: ed.length / 2, unknown: e.unknown, truncated: e.truncated };
  return { stamp: e.stamp, state: 'not edited', edits: ed.length / 2, unknown: e.unknown, truncated: e.truncated };
};

const seek = async (sec, force = true) => {
  w.timeGoto(sec);
  if (force) w.histSync(true);
  await raf(); await raf();
  return { asked: sec, sec: w.time().sec, cur: w.time().cur, ...stateAtVoxel() };
};

const base = w.time().base;
out.walk = [];
const t0 = Math.floor(mine[0].t / 1000) - base;
out.base = base; out.t0 = t0;
for (const d of [-120, -60, -5, -1, 0, 1, 5, 60, 600]) {
  out.walk.push({ offset: d, ...(await seek(t0 + d)) });
}
// And the end of the log: nothing in the replay is newer, so today's payload must be left alone.
w.timeSeekRow(w.time().quads - 1);
w.histSync(true);
await raf(); await raf();
out.walkEnd = { ...(await Promise.resolve({ sec: w.time().sec, ...stateAtVoxel() })), verts: w.state.detailVerts };

// What is really in the store there today (the store is never touched by a replay).
out.storeToday = w.at(vox.x, vox.y, vox.z);
out.errors = { page: w.pageErrors?.() ?? null };
return out;
