// The screenshot shows a house the replay was supposed to take away. Before touching code again, ask
// the save: which blocks is that house, and does the ledger have a single row on any of them?
//
// Reads the same payload bytes the browser fetches from a running worldd, so a mismatch here cannot be
// blamed on the renderer's copy of the world.
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { openChunk } from '../server/chunk-payload.mjs';
import { readPack, decodeTimeline } from '../shared/ledger-pack.mjs';

const base = 'http://127.0.0.1:8765';
const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const keyOf = (id) => (id ? atlas.states[id - 1]?.k ?? `id:${id}` : 'unknown');
// Air is a real palette entry with a real id, so "solid" has to mean "not air", not "not zero".
const AIR = atlas.states.findIndex((s) => s.k === 'minecraft:air') + 1;
const solid = (id) => id && id !== AIR;

const CX0 = -7, CX1 = 1, CZ0 = -13, CZ1 = -5;         // the box the screenshot frames
const chunks = new Map();
for (let cz = CZ0; cz <= CZ1; cz++) {
  for (let cx = CX0; cx <= CX1; cx++) {
    const r = await fetch(`${base}/voxel?dim=overworld&cx=${cx}&cz=${cz}`);
    if (!r.ok) { console.log(`${cx},${cz}: http ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) continue;
    chunks.set(`${cx},${cz}`, openChunk(buf));
  }
}
console.log(`${chunks.size} chunk payloads in ${CX0}..${CX1} x ${CZ0}..${CZ1}`);

// A house is a column that stands well above its neighbours. Ground here is y ~64, so any column whose
// top reaches y 72+ is either a tree or a building; the material histogram then splits them.
const tall = [];
const names = new Map();
for (const [k, ch] of chunks) {
  const [cx, cz] = k.split(',').map(Number);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const wx = cx * 16 + lx, wz = cz * 16 + lz;
    let top = -1e9, floor = 1e9;
    for (let y = ch.yMin + ch.yCount * 16 - 1; y >= ch.yMin; y--) {
      if (solid(ch.stateAt(lx, y, lz))) { top = y; break; }
    }
    if (top < 72) continue;
    // the first solid below the top that is not the same block: how deep the "crown" goes
    tall.push({ wx, wz, top, cx, cz });
    for (let y = top; y >= Math.max(ch.yMin, 60); y--) {
      const id = ch.stateAt(lx, y, lz);
      if (!solid(id)) continue;
      const n = keyOf(id);
      names.set(n, (names.get(n) || 0) + 1);
    }
  }
}
const topNames = [...names].sort((a, b) => b[1] - a[1]).slice(0, 18);
console.log(`${tall.length} columns reach y >= 72`);
for (const [n, c] of topNames) console.log(`  ${String(c).padStart(6)}  ${n}`);

// Which of those materials is the house? The screenshot's walls are one dark stone-ish block, so the
// dominant non-foliage/non-dirt material above ground is it.
const HOUSE = process.env.HOUSE;
const isHouse = (n) => (HOUSE ? n.includes(HOUSE)
  : /stone|brick|deepslate|tile|panel|plank|log|glass|slab|stairs|fence|door|iron/.test(n)
    && !/leaves|grass|dirt|snow|air|water|root/.test(n));

const packRaw = fs.readFileSync('build/ledger/region.ledpack');
const pack = readPack(packRaw);
const tl = decodeTimeline(packRaw.subarray(pack.tlBytes[0], pack.tlBytes[1]));
const base2 = tl.timeBaseSec;
const PH = Math.floor(new Date('2024-06-01T23:00:38+02:00').getTime() / 1000) - base2;

// Index every row of the touched chunks by absolute voxel.
const cellOf = new Map();
for (let i = 0; i < pack.cellCount; i++) { const c = pack.cell(i); cellOf.set(`${c.cx},${c.cz}`, i); }
const rowsAt = new Map();
for (let i = 0; i < tl.count; i++) {
  const c = pack.cell(tl.cellOf(i));
  const wx = c.cx * 16 + tl.x(i), wy = tl.y(i), wz = c.cz * 16 + tl.z(i);
  const k = `${wx},${wy},${wz}`;
  let a = rowsAt.get(k);
  if (!a) rowsAt.set(k, a = []);
  a.push(i);
}

const stats = { vox: 0, logged: 0, newer: 0, behind: 0, onlyBehind: 0 };
const sample = [];
const byName = new Map();
for (const t of tall) {
  for (let y = Math.max(60, t.top - 40); y <= t.top; y++) {
    const ch = chunks.get(`${t.cx},${t.cz}`);
    const id = ch.stateAt(t.wx - t.cx * 16, y, t.wz - t.cz * 16);
    if (!solid(id)) continue;
    const n = keyOf(id);
    if (!isHouse(n)) continue;
    stats.vox++;
    byName.set(n, (byName.get(n) || 0) + 1);
    const rows = rowsAt.get(`${t.wx},${y},${t.wz}`);
    if (!rows?.length) continue;
    stats.logged++;
    const nw = rows.filter((i) => tl.sec[i] > PH).length;
    const bh = rows.length - nw;
    if (nw) stats.newer++;
    if (bh) stats.behind++;
    if (bh && !nw) stats.onlyBehind++;
    if (sample.length < 6 && nw) {
      sample.push({ v: `${t.wx},${y},${t.wz}`, name: n, rows: rows.length, newer: nw, behind: bh,
        first: new Date((base2 + tl.sec[rows[0]]) * 1000).toISOString(),
        lastName: tl.nameOf(rows[0]), lastWas: tl.wasOf(rows[0]) });
    }
  }
}
console.log(`playhead sec ${PH}  ${new Date((base2 + PH) * 1000).toISOString()}`);
console.log(`house-material voxels in tall columns: ${stats.vox}`);
console.log(`  with >=1 ledger row on that exact voxel: ${stats.logged}`);
console.log(`  with a row NEWER than the playhead (undoable): ${stats.newer}`);
console.log(`  with a row at/behind the playhead: ${stats.behind}`);
console.log(`  logged but only BEFORE the playhead (must stand): ${stats.onlyBehind}`);
console.log(`  never logged at all: ${stats.vox - stats.logged}`);
for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`    ${String(c).padStart(6)}  ${n}`);
for (const s of sample) console.log(`  sample ${JSON.stringify(s)}`);
