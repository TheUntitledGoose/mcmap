// The card's other button: "when did THIS block happen". It has to move the replay cursor to the row the
// card line names - one second BEFORE a break (the last moment it still stood), its own second for a place
// - and it has to say so when the current player/kind filter means the block is not in the replay set.
// The block asked about is chosen from the real /ledger/rows response, because a hand-picked coordinate in
// a chunk with 4,254 rows can still be 30 blocks from every one of them.
const w = window.__world;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const settle = async (n) => { for (let i = 0; i < n; i++) { await raf(); w.tick(1); } };
const NAME = ['', 'unknown', 'place', 'break', 'shoot', 'bucket', 'explode', 'other'];
const kindOf = (r) => NAME[+r.cls] ?? `#${r.cls}`;
const dateShown = () => {
  const row = [...document.querySelectorAll('.panel-row')].find((x) => /playhead/i.test(x.textContent || ''));
  return row ? (row.querySelector('.panel-val')?.textContent || '').trim() : null;
};
const out = { settings: { time: w.state.time, terrain: w.histWanted() ? 1 : 0, tiles: w.overlay().tiles,
  timeCls: w.state.timeCls, who: w.ledger().who, dim: w.state.dim } };
await settle(150);
const snap = (tag) => ({ tag, cur: Math.round(w.time().cur), drawn: w.time().drawn, sec: w.time().sec,
  date: dateShown(), detailVerts: w.state.detailVerts, histChunks: w.hist().chunks, histEdits: w.hist().edits });

// The two ends of the replay, so "the blocks moved" has a ruler next to it.
w.timeSeekRow(w.time().quads - 1); await settle(90); out.atEnd = snap('end');
w.timeSeekRow(0); await settle(90); out.atStart = snap('start');

// Real rows of the loudest chunk, straight from the point-query endpoint.
const url = `/ledger/rows?dim=${encodeURIComponent(w.state.dim)}&cx=-3&cz=-8&cls=0&player=0&limit=600`;
const got = await (await fetch(url)).json();
const rows = got.rows ?? [];
out.fetched = { rows: rows.length, total: got.total };
const named = rows.filter((r) => r.block);
const pickBr = named.find((r) => kindOf(r) === 'break');
const pickPl = named.find((r) => kindOf(r) === 'place');
out.pick = { breakRow: pickBr, placeRow: pickPl, namedCount: named.length };
if (!pickBr && !pickPl) return out;

const lines = () => [...document.querySelectorAll('.lcard-line')];
const lineText = (l) => (l.querySelector('.lcard-row')?.textContent || '').replace(/\s+/g, ' ').trim();
const noteEl = () => document.querySelector('.lcard-note');

async function press(line) {
  const btn = line.querySelector('.lcard-seek');
  btn.click();
  const stuck = () => btn.classList.contains('busy') || noteEl().textContent.includes('rewinding');
  for (let i = 0; i < 600 && stuck(); i++) {
    await raf(); w.tick(1);
  }
  await settle(60);
  return noteEl().textContent.replace(/\s+/g, ' ').trim();
}
const baseOf = () => w.time().base;
const expectSec = (r) => Math.floor(r.t / 1000) - baseOf() - (kindOf(r) === 'break' ? 1 : 0);

// Case A: replay filter is "any change", so both a break and a place row are inside the replay.
out.caseA = {};
await w.ledgerAsk(pickBr.x, pickBr.y, pickBr.z);
await settle(40);
out.caseA.cardLines = lines().length;
out.caseA.firstLine = lines().length ? lineText(lines()[0]) : null;
const la = lines().find((l) => /\bbreak\b/.test(lineText(l)) && lineText(l).includes(String(pickBr.block.split(':')[1] ?? '')))
  ?? lines().find((l) => /\bbreak\b/.test(lineText(l)));
out.caseA.chosen = la ? lineText(la) : null;
out.caseA.note = la ? await press(la) : null;
out.caseA.after = snap('afterBreak');
out.caseA.expectSec = la ? expectSec(pickBr) : null;
out.caseA.secDelta = la ? w.time().sec - expectSec(pickBr) : null;
out.caseA.nearRowsDrawn = la ? w.time().drawn : null;

// Case B: replay filtered to places only. The same break row is outside the replay set: the playhead may
// still travel to that moment, but the answer must not claim this block is one of the changes being shown.
out.caseB = {};
w.set('timeCls', 2);
await settle(150);
out.caseB.timeCls = w.time().cls;
await w.ledgerAsk(pickBr.x, pickBr.y, pickBr.z);
await settle(40);
const lb = lines().find((l) => /\bbreak\b/.test(lineText(l)));
out.caseB.chosen = lb ? lineText(lb) : null;
out.caseB.breakNote = lb ? await press(lb) : null;
out.caseB.afterBreak = snap('afterBreakFiltered');
const lp = lines().find((l) => /\bplace\b/.test(lineText(l)));
out.caseB.placeRow = lp ? lineText(lp) : null;
out.caseB.placeNote = lp ? await press(lp) : null;
out.caseB.afterPlace = snap('afterPlaceFiltered');
out.errors = { page: w.state.bootError, frames: w.state.frameErrors };
return out;
