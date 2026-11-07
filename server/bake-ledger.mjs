// M12 bake CLI: exported log -> one sparse pack per dimension + a meta.json the server and the browser
// both read. Run after tools/ledger-export.py.
//
//   node server/bake-ledger.mjs [--world DarkRPG/world] [--out build/ledger] [--export build/ledger/actions.bin]
import fs from 'node:fs';
import path from 'node:path';
import { readLedger, formatLedgerTime } from '../shared/ledger-format.mjs';
import { buildPack, writePack } from './ledger-pack.mjs';
import { WorldService } from './world-service.mjs';
import {
  HEIGHT_BIAS, OVERVIEW_HEADER, OVERVIEW_MAGIC, OVERVIEW_VERSION, OVERVIEW_VERSION_MIN,
} from '../shared/chunk-format.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const worldRoot = flag('world', 'DarkRPG/world');
const outDir = flag('out', 'build/ledger');
const exportPath = flag('export', path.join(outDir, 'actions.bin'));
const shellDir = flag('packs', 'build/shells');

/**
 * The baked whole-dimension overview, read only for its ground plane.
 *
 * The ledger pack carries a ground height per touched chunk so the browser can put its activity
 * overlay on the ground without owning a height source of its own: the world layer is off by default
 * here (the baked LOD tiles replaced it), so an overlay that wanted terrain heights would either
 * switch a 16 MB layer on or have nothing to sit on. Copying the answer at bake time costs 2 bytes
 * per touched chunk and no browser request.
 */
function overviewHeights(dimKey) {
  const file = path.join(shellDir, `overview-${dimKey}.bin`);
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  if (b.length < OVERVIEW_HEADER || b.subarray(0, 8).toString('ascii') !== OVERVIEW_MAGIC) {
    throw new Error(`${file}: not an overview frame`);
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint16(8, true);
  if (version < OVERVIEW_VERSION_MIN || version > OVERVIEW_VERSION) {
    throw new Error(`${file}: overview version ${version} not in ${OVERVIEW_VERSION_MIN}..${OVERVIEW_VERSION}`);
  }
  const cell = dv.getUint16(10, true);
  const x0 = dv.getInt32(16, true), z0 = dv.getInt32(20, true);
  const w = dv.getUint16(24, true), h = dv.getUint16(26, true);
  const n = w * h;
  // Planes, in the order bake-shells writes them: height, state, ground, cover, then the byte planes.
  if (b.length < OVERVIEW_HEADER + 4 * n * 2 + n) throw new Error(`${file}: overview frame truncated`);
  const groundAt = OVERVIEW_HEADER + 2 * n * 2;
  return (cx, cz) => {
    const i = Math.floor((cx - x0) / cell), j = Math.floor((cz - z0) / cell);
    if (i < 0 || j < 0 || i >= w || j >= h) return null;
    const hb = dv.getUint16(groundAt + (j * w + i) * 2, true);
    return hb ? hb - HEIGHT_BIAS : null;
  };
}

if (!fs.existsSync(exportPath)) {
  throw new Error(`no ${exportPath} - run: python tools/ledger-export.py`);
}
const t0 = Date.now();
const L = readLedger(fs.readFileSync(exportPath));
const srcStat = fs.statSync(exportPath);

// Dimension identity comes from the same registry the running server uses, so a pack name can never
// disagree with the dim key a browser asks for.
const svc = new WorldService(worldRoot, new Map(), '', {});
const byId = new Map([...svc.dims].map(([id, d]) => [id, d]));

const dims = [];
const unmatched = [];
for (const [worldId, w] of [...L.worlds].sort((a, b) => a[0] - b[0])) {
  const d = byId.get(w.id);
  if (!d) {
    unmatched.push({ worldId, dimId: w.id, reason: 'this save has no region folder for it' });
    continue;
  }
  const heightOf = overviewHeights(d.key);
  const built = buildPack(L, worldId, d.key, { heightOf });
  if (!built.rowCount) {
    unmatched.push({ worldId, dimId: w.id, reason: 'the log holds no rows for this dimension' });
    continue;
  }
  const file = writePack(outDir, d.key, built.buf);
  dims.push({
    worldId, dimId: w.id, dimKey: d.key,
    rows: built.rowCount, cells: built.cellCount,
    tMinSec: built.tMin, tMaxSec: built.tMax,
    first: formatLedgerTime(built.tMin * 1000), last: formatLedgerTime(built.tMax * 1000),
    bytes: built.buf.length, pack: path.basename(file),
    heights: heightOf ? 'from overview' : 'none (no overview frame baked for this dimension)',
  });
  console.log(`  ${w.id.padEnd(28)} ${String(built.rowCount).padStart(7)} rows -> ` +
    `${String(built.cellCount).padStart(6)} chunk cells, ${(built.buf.length / 1024).toFixed(0)} KiB` +
    `${heightOf ? '' : '  (no ground heights: run bake-shells first)'}`);
}

const meta = {
  generated: new Date().toISOString(),
  source: { path: exportPath, bytes: srcStat.size, mtimeMs: Math.round(srcStat.mtimeMs) },
  players: [...L.players].map(([id, p]) => ({
    id, name: p.name,
    firstJoinMs: Number(p.firstJoinMs), lastJoinMs: Number(p.lastJoinMs),
  })),
  actions: [...L.actions].map(([id, a]) => ({ id, name: a.id })),
  sources: [...L.sources].length,
  objects: [...L.objects].length,
  totalRows: L.count,
  dims, unmatched,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${path.join(outDir, 'meta.json')}.tmp`, JSON.stringify(meta, null, 1));
fs.renameSync(`${path.join(outDir, 'meta.json')}.tmp`, path.join(outDir, 'meta.json'));

for (const u of unmatched) console.log(`  (no pack) ${u.dimId}: ${u.reason}`);
console.log(`ledger bake: ${L.count} rows, ${dims.length} packs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  wrote ${meta.dims.map((d) => `${d.pack} ${(d.bytes / 1024) | 0} KiB`).join(', ')}`);
