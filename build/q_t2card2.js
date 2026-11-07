// "Jump to when this block was placed", proved at the voxel level.
//
// The card's ⏪ has to put the playhead on the place row's OWN second (a place is a block arriving), and at
// that second the voxel undo must no longer be taking that block away. One second earlier it must be. The
// edit list is the place that claim is checkable: a taken-away block is an edit whose state id is 0.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const NAME = { 1: 'change', 2: 'place', 3: 'break', 4: 'insert', 5: 'delete' };
const Y_BIAS = 4096;
const packLocal = (x, y, z) => (x & 15) | ((z & 15) << 4) | (((y + Y_BIAS) & 0x1FFF) << 8);
const out = { settings: { time: w.state.time, terrain: w.histWanted() ? 1 : 0, tiles: w.overlay().tiles,
  timeCls: w.time().cls, who: w.ledger().who } };
await settle(150);

// Pick a real placement of a real block in the loudest chunk, straight from the point-query endpoint.
const url = `/ledger/rows?dim=${encodeURIComponent(w.state.dim)}&cx=-3&cz=-8&cls=2&player=0&limit=900`;
const got = await (await fetch(url)).json();
const cand = (got.rows ?? []).filter((r) => NAME[+r.cls] === 'place' && r.block && r.block !== 'minecraft:air'
  && r.y > -4000 && r.y < 4000);
out.candidates = { fetched: (got.rows ?? []).length, usable: cand.length };
if (!cand.length) return out;
// Prefer one whose block the atlas can draw (the undo can only restore a name the state table knows).
const r = cand[0];
const CX = r.x >> 4, CZ = r.z >> 4;
const packed = packLocal(r.x - CX * 16, r.y, r.z - CZ * 16);
out.row = { t: r.t, sec: Math.floor(r.t / 1000), x: r.x, y: r.y, z: r.z, block: r.block, player: r.player,
  chunk: [CX, CZ], packed };

const card = async () => { await w.ledgerAsk(r.x, r.y, r.z); await settle(40); };
const lines = () => [...document.querySelectorAll('.lcard-line')];
const lineText = (l) => (l.querySelector('.lcard-row')?.textContent || '').replace(/\s+/g, ' ').trim();
const has = (l, word) => lineText(l).includes(word);
async function press(line) {
  const btn = line.querySelector('.lcard-seek');
  btn.click();
  const stuck = () => btn.classList.contains('busy') || document.querySelector('.lcard-note').textContent.includes('rewinding');
  for (let i = 0; i < 900 && stuck(); i++) { await raf(); w.tick(1); }
  await settle(90);
  return document.querySelector('.lcard-note').textContent.replace(/\s+/g, ' ').trim();
}
const editHere = () => {
  const e = w.histEditsOf(CX, CZ);
  const arr = e.edits ?? [];
  let state = null;
  for (let i = 0; i + 1 < arr.length; i += 2) if (arr[i] === packed) state = arr[i + 1];
  return { stamp: e.stamp, edits: arr.length / 2, unknown: e.unknown, truncated: e.truncated,
    voxelState: state, marked: w.hist().marked, chunks: w.hist().chunks };
};

await card();
const pl = lines().find((l) => has(l, 'place') && lineText(l).includes(r.block));
out.card = { lines: lines().length, chosen: pl ? lineText(pl) : null,
  all: lines().slice(0, 8).map(lineText) };
if (!pl) return out;
out.note = await press(pl);
const base = w.time().base;
out.atPlace = { cur: Math.round(w.time().cur), sec: w.time().sec, drawn: w.time().drawn,
  expectSec: Math.floor(r.t / 1000) - base, detailVerts: w.state.detailVerts, edits: editHere() };
// A few seconds before the placement: the same row is now NEWER than the playhead, so its block is taken
// back out and the voxel must appear in the edit list as "remove" (state 0).
w.timeSeekRow(Math.max(0, w.time().cur - 1));
w.timeGoto(w.time().sec - 3);
await settle(90);
out.beforePlace = { sec: w.time().sec, drawn: w.time().drawn, detailVerts: w.state.detailVerts,
  edits: editHere() };
// And at the end of the log the block is present again: no edit for it at all.
w.timeSeekRow(w.time().quads - 1);
await settle(90);
out.atEnd = { sec: w.time().sec, drawn: w.time().drawn, detailVerts: w.state.detailVerts, edits: editHere() };
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
