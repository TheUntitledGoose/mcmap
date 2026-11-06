// dbg-mergerate — price 9.5 (merge coplanar quads) before writing it.
//
// It does not reimplement the mesher. It reads the vertex streams meshChunk already emits - the
// same bytes a worker posts to the GPU - recovers each quad's corners from its triangle pair, and
// asks how many of those quads could become one rectangle without moving sprite, winding or shade.
// Four layouts are then priced per chunk:
//
//   soup    6 verts per quad, what ships today
//   welded  one vert per unique corner + an index buffer: same faces, shared corners
//   merged  one rect per run of squares + indices, under three rules:
//           flat   the run's shade is one constant colour, so merging changes nothing at all
//           plane  the run's corner shades lie on a plane, so a big triangle still interpolates
//                  exactly the shades the four little ones had (affine, not bilinear: a quad is
//                  two triangles, and an s*t cross term would not survive that split)
//           seam   only the corners touching a seam have to agree - the interior corner shades are
//                  then thrown away and interpolated instead, which is the look AO would lose
//
// A rect wider than one block samples its sprite more than once, so the run also says how much of
// the merged area needs uv tiling, and how much of it sits on a sprite that is one flat colour in
// the atlas and could be shaded without a second texture read.
//
//   node build/dbg-mergerate.mjs                    # a spread of generated chunks, shipped settings
//   node build/dbg-mergerate.mjs 3,3 -4,7           # your chunks
//   node build/dbg-mergerate.mjs --caves            # every face meshed, the worst case
import { readFileSync } from 'node:fs';
import { openChunk } from '../web/js/payload.js';
import { Assets } from '../web/js/assets.js';
import { meshChunk } from '../web/js/mesher.js';
import { WorldService } from '../server/world-service.mjs';
import { buildStateIds } from '../server/chunk-payload.mjs';
import { stateIndexAt, lightLevelAt, skyLevelAt, sectionIndex } from '../web/js/lookup.js';
import { decodePng } from '../server/png.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const VALUED = ['dim', 'grid'];
const flagVal = (f, d) => { const i = argv.indexOf(`--${f}`); return i < 0 ? d : +argv[i + 1]; };
// Only tokens that are not a flag or a flag's value are chunk coordinates.
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUED.includes(argv[i].slice(2))) i++; continue; }
  rest.push(argv[i]);
}
let coords = rest.map((a) => a.split(',').map(Number));
const DIM = flagVal('dim', null) ? String(argv[argv.indexOf('--dim') + 1]) : 'minecraft:overworld';

const atlas = JSON.parse(readFileSync('build/assets/atlas.json', 'utf8'));
const ids = buildStateIds(atlas.states.map((s) => s.k));
const svc = new WorldService('DarkRPG/world', ids, 'build/cache', {});
const geoBuf = readFileSync('build/assets/geometry.bin');
const assets = new Assets(atlas, geoBuf.buffer.slice(geoBuf.byteOffset, geoBuf.byteOffset + geoBuf.byteLength));

if (!coords.length) {
  // Spawn plus a grid over the parts of the dimension that actually generated. A fixed list of
  // far-away coordinates is not a sample of this world: most of them are ungenerated.
  const meta = svc.dimList().find((d) => d.id === DIM || d.key === DIM);
  const sx = 3, sz = 3;                          // the view the viewer opens on
  coords.push([sx, sz]);
  const ex = meta.chunkExtent;                   // already chunk coordinates
  const span = Math.min(140, ex.maxX - ex.minX, ex.maxZ - ex.minZ);
  const cx0 = Math.max(ex.minX, Math.min(ex.maxX - span, sx - span / 2));
  const cz0 = Math.max(ex.minZ, Math.min(ex.maxZ - span, sz - span / 2));
  const G = flagVal('grid', 6);
  const step = Math.max(1, Math.round(span / G));
  for (let a = 0; a < G; a++) {
    for (let b = 0; b < G; b++) coords.push([cx0 + a * step + ((a * 7 + b * 13) % 5), cz0 + b * step + ((b * 11 + a * 3) % 7)]);
  }
}

const opts = {
  ao: 1, aoMin: 0.42, lightOn: 1, darkFloor: 0.32, darkGamma: 0.72, skyScale: 1,
  // Shipped default is "no caves": a face in total darkness is dropped, as is rock with no sky
  // within `buried` blocks. --caves asks for every face, the worst case for merging.
  darkcut: has('caves') ? -1 : 0,
  buried: has('caves') ? 0 : 4,
  buriedSky: 2,
  surfaceOnly: has('surface') ? 1 : 0,
};

/** A Node Buffer into the ArrayBuffer the browser reader wants. */
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const Q = 16;                                     // geometry is in blocks, on a 1/16 grid
const rq = (v) => Math.round(v * Q);
const uq = (v) => Math.round(v * 1e5);
const chOf = (c, k) => (c >> (8 * k)) & 255;

/** Is this atlas cell one flat colour? A merged face over it can skip the second texture read. */
const flatCache = new Map();
let atlasPx = null, atlasW = 0;
function isFlatTex(ti) {
  if (flatCache.has(ti)) return flatCache.get(ti);
  if (!atlasPx) { const p = decodePng(readFileSync('build/assets/atlas.png')); atlasPx = p.rgba; atlasW = p.w; }
  const t = assets.texCell(ti);
  if (!t) { flatCache.set(ti, false); return false; }
  let lo = 1e9, hi = -1e9;
  for (let y = 0; y < t.h && hi - lo <= 1; y++) {
    for (let x = 0; x < t.w; x++) {
      const o = ((t.y + y) * atlasW + t.x + x) * 4;
      for (let k = 0; k < 3; k++) { const v = atlasPx[o + k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  flatCache.set(ti, hi - lo <= 1);
  return flatCache.get(ti);
}
// uv rect -> texture index, so a quad's sprite is recovered from its own corners.
const byUV = new Map();
for (let ti = 0; ti < assets.textures.length; ti++) {
  const t = assets.texCell(ti);
  if (t) byUV.set(`${Math.round(t.u0 * 1e6)},${Math.round(t.v0 * 1e6)}`, ti);
}

/**
 * Recover the quads a stream draws. A quad is emitted as two triangles, either
 * (p0,p1,p2,p0,p2,p3) or (p1,p2,p3,p1,p3,p0) depending on which diagonal the mesher picked, so
 * corners are identified by coordinate and the winding choice does not matter.
 */
function quadsOf(s) {
  const P = s.position, U = s.uv, C = s.color;
  // Squares are bucketed per plane: two faces with the same in-plane coordinates but on different
  // planes (a wall at x=5 and one at x=6) must never meet in one grid.
  const out = { unit: 0, odd: 0, weld: new Set(), weldOdd: new Set(), planes: new Map(), quads: s.count / 6, why: new Map(), dims: new Map() };
  const addOdd = (co, uu, vv, cc, why, dims) => {
    out.odd++;
    if (why) out.why.set(why, (out.why.get(why) || 0) + 1);
    if (dims) out.dims.set(dims, (out.dims.get(dims) || 0) + 1);
    for (let i = 0; i < 4; i++) out.weldOdd.add(`${rq(co[0][i])},${rq(co[1][i])},${rq(co[2][i])}|${uq(uu[i])},${uq(vv[i])}|${cc[i]}`);
  };
  for (let q = 0; q < out.quads; q++) {
    const b = q * 6;
    const co = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];   // co[axis][corner]
    const uu = [0, 0, 0, 0], vv = [0, 0, 0, 0], cc = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const v = b + (i === 3 ? 5 : i);
      co[0][i] = P[v * 3]; co[1][i] = P[v * 3 + 1]; co[2][i] = P[v * 3 + 2];
      uu[i] = U[v * 2]; vv[i] = U[v * 2 + 1];
      cc[i] = (C[v * 4] << 16) | (C[v * 4 + 1] << 8) | C[v * 4 + 2];
    }
    for (let i = 0; i < 4; i++) {
      out.weld.add(`${rq(co[0][i])},${rq(co[1][i])},${rq(co[2][i])}|${uq(uu[i])},${uq(vv[i])}|${cc[i]}`);
    }
    const e1 = [co[0][1] - co[0][0], co[1][1] - co[1][0], co[2][1] - co[2][0]];
    const e2 = [co[0][3] - co[0][0], co[1][3] - co[1][0], co[2][3] - co[2][0]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
    const ax = a[0] >= a[1] && a[0] >= a[2] ? 0 : (a[1] >= a[0] && a[1] >= a[2] ? 1 : 2);
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    // Only an axis-aligned unit square can join a rectangle: partial-height model faces (slabs,
    // panes, fence posts) and rotated model arms would need a general polygon union.
    if (!(len > 0.5 && Math.abs(a[ax] - len) < 1e-4 && Math.abs(l1 - 1) < 1e-4 && Math.abs(l2 - 1) < 1e-4)) {
      const u0 = Math.min(...uu), u1 = Math.max(...uu), v0 = Math.min(...vv), v1 = Math.max(...vv);
      const ti = byUV.get(`${Math.round(u0 * 1e6)},${Math.round(v0 * 1e6)}`);
      addOdd(co, uu, vv, cc, !(len > 0.5 && Math.abs(a[ax] - len) < 1e-4) ? 'not axis aligned'
        : (Math.abs(l1 - 1) > 1e-4 || Math.abs(l2 - 1) > 1e-4 ? 'not a unit square' : 'degenerate'),
        `${l1.toFixed(3)}x${l2.toFixed(3)}@${atlas.textures[ti]?.id ?? ti}`);
      continue;
    }
    const ua = ax === 0 ? 1 : 0, va = ax === 2 ? 1 : 2;
    const g0 = Math.min(...co[ua]), g1 = Math.min(...co[va]);
    const du = [], dv = [], seen = new Set();
    for (let i = 0; i < 4; i++) {
      du[i] = Math.round(co[ua][i] - g0); dv[i] = Math.round(co[va][i] - g1);
      if (du[i] > 1 || dv[i] > 1) break;
      seen.add(dv[i] * 2 + du[i]);
    }
    if (seen.size !== 4) {
      const l1b = Math.hypot(e1[0], e1[1], e1[2]), l2b = Math.hypot(e2[0], e2[1], e2[2]);
      addOdd(co, uu, vv, cc, 'corners do not fill a 2x2 cell', `${l1b.toFixed(3)}x${l2b.toFixed(3)}`);
      continue;
    }
    const colBy = [0, 0, 0, 0], uvBy = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const gi = dv[i] * 2 + du[i];
      colBy[gi] = cc[i]; uvBy[gi * 2] = uq(uu[i]); uvBy[gi * 2 + 1] = uq(vv[i]);
    }
    const u0 = Math.min(...uu), u1 = Math.max(...uu), v0 = Math.min(...vv), v1 = Math.max(...vv);
    const ti = byUV.get(`${Math.round(u0 * 1e6)},${Math.round(v0 * 1e6)}`);
    const flat = cc[0] === cc[1] && cc[0] === cc[2] && cc[0] === cc[3];
    const rec = {
      ax, nsign: n[ax] > 0 ? 1 : 0, gu: rq(g0), gv: rq(g1), ti, colBy, uvBy, flat,
      // Same sprite, same size, same orientation: the uv pattern has to be identical, not merely the
      // same texture, or a run would tile a mirrored face.
      sig: `${ti}|${uvBy.join(',')}`,
    };
    out.unit++;
    const pk = `${ax},${rq(co[ax][0])}`;
    if (!out.planes.has(pk)) out.planes.set(pk, new Map());
    out.planes.get(pk).set(`${rec.gu},${rec.gv}`, rec);
  }
  return out;
}

const STEP = 16;                                  // one block, in the 1/16 grid used above

/**
 * Greedy rectangle cover of the unit squares on one plane. `rule` says what a run may absorb:
 *
 *   flat   every corner of every square in the run carries the same colour
 *   plane  the run's shades lie on one plane, so splitting the merged rect into two triangles
 *          still reproduces every corner shade the separate squares had
 *   seam   the squares only have to agree where they touch; interior corner shades are then
 *          interpolated instead of stored, which is what AO would lose
 */
function cover(cells, rule) {
  const at = (gu, gv) => cells.get(`${gu},${gv}`) || null;
  const TOL = 1.5;                                // colours are u8, so a plane may miss by a step
  const sameSprite = (x, y) => !!x && !!y && x.nsign === y.nsign && x.sig === y.sig;

  // All corner colours inside the candidate rect, compared against what the rule allows.
  const okRect = (gu0, gv0, w, h) => {
    const cellAt = (i, j) => at(gu0 + STEP * i, gv0 + STEP * j);
    const base = cellAt(0, 0);
    if (!base) return false;
    // The merged rect will carry four shades only: its own corners. Those are the shades of the
    // corner cells at the rect's four extremes.
    const c00 = base.colBy[0], c10 = cellAt(w - 1, 0)?.colBy[1], c01 = cellAt(0, h - 1)?.colBy[2];
    if (rule === 'plane' && (!c10 || !c01)) return false;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = cellAt(i, j);
        if (!c || !sameSprite(base, c)) return false;
        for (let dj = 0; dj <= 1; dj++) {
          for (let di = 0; di <= 1; di++) {
            const col = c.colBy[dj * 2 + di];
            if (rule === 'flat') {
              if (col !== base.colBy[0]) return false;
            } else if (rule === 'plane') {
              for (let k = 0; k < 3; k++) {
                const pred = chOf(c00, k) + (chOf(c10, k) - chOf(c00, k)) * (i + di) / w
                  + (chOf(c01, k) - chOf(c00, k)) * (j + dj) / h;
                if (Math.abs(chOf(col, k) - pred) > TOL) return false;
              }
            }
          }
        }
        if (rule === 'seam') {
          if (i + 1 < w) {                                   // seam to the square on the right
            const b = at(gu0 + STEP * (i + 1), gv0 + STEP * j);
            if (b && !(c.colBy[1] === b.colBy[0] && c.colBy[3] === b.colBy[2])) return false;
          }
          if (j + 1 < h) {                                   // seam to the square above
            const b = at(gu0 + STEP * i, gv0 + STEP * (j + 1));
            if (b && !(c.colBy[2] === b.colBy[0] && c.colBy[3] === b.colBy[1])) return false;
          }
        }
      }
    }
    return true;
  };

  const rects = [];
  const used = new Set();
  for (const key of cells.keys()) {
    if (used.has(key)) continue;
    const a = cells.get(key);
    let w = 1;
    while (at(a.gu + STEP * w, a.gv) && !used.has(`${a.gu + STEP * w},${a.gv}`)
      && sameSprite(a, at(a.gu + STEP * w, a.gv)) && okRect(a.gu, a.gv, w + 1, 1)) w++;
    let h = 1;
    while (true) {
      let rowOK = true;
      for (let i = 0; i < w; i++) {
        const k = `${a.gu + STEP * i},${a.gv + STEP * h}`;
        if (!at(a.gu + STEP * i, a.gv + STEP * h) || used.has(k)) { rowOK = false; break; }
      }
      if (!rowOK || !okRect(a.gu, a.gv, w, h + 1)) break;
      h++;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used.add(`${a.gu + STEP * i},${a.gv + STEP * j}`);
    rects.push({ w, h, ti: a.ti, area: w * h });
  }
  return rects;
}

const RULES = ['flat', 'plane', 'seam'];
const tot = { quads: 0, unit: 0, odd: 0, weld: 0, weldOdd: 0, ms: 0, mergeMs: 0, rects: [0, 0, 0], tiled: [0, 0, 0], tiledFlat: [0, 0, 0] };
const hist = [new Map(), new Map(), new Map()];
const perPass = [0, 0, 0];
const whyTot = new Map(), dimsTot = new Map();
const rows = [];
const quadCounts = [];
let samples = 0;
for (const [cx, cz] of coords) {
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
  const buf = svc.chunkBytes(DIM, cx, cz);
  if (!buf) continue;
  const map = new Map();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const nb = svc.chunkBytes(DIM, cx + dx, cz + dz);
      if (nb) { const ch = openChunk(ab(nb)); map.set(`${cx + dx},${cz + dz}`, { ch, secOf: sectionIndex(ch) }); }
    }
  }
  const chunk = map.get(`${cx},${cz}`).ch;
  const getCh = (x, z) => map.get(`${x},${z}`);
  const at = (ccx, ccz, lx, ly, lz) => stateIndexAt(getCh, ccx, ccz, lx, ly, lz, assets.states.length);
  const o = { ...opts };
  o.light = (x, z, lx, ly, lz) => lightLevelAt(getCh, x, z, lx, ly, lz, 1);
  o.sky = (x, z, lx, ly, lz) => skyLevelAt(getCh, x, z, lx, ly, lz);
  const t0 = performance.now();
  const { streams } = meshChunk(assets, chunk, at, o);
  tot.ms += performance.now() - t0;
  const t1 = performance.now();
  let sq = 0, unit = 0, odd = 0, weld = 0, weldOdd = 0;
  const rc = [0, 0, 0];
  streams.forEach((s, pass) => {
    if (!s.count) return;
    perPass[pass] += s.count / 6;
    const q = quadsOf(s);
    sq += q.quads; unit += q.unit; odd += q.odd; weld += q.weld.size; weldOdd += q.weldOdd.size;
    if (has('why')) {
      for (const [k, v] of q.why) whyTot.set(k, (whyTot.get(k) || 0) + v);
      for (const [k, v] of q.dims) dimsTot.set(k, (dimsTot.get(k) || 0) + v);
    }
    RULES.forEach((rule, ri) => {
      for (const cells of q.planes.values()) {
        for (const r of cover(cells, rule)) {
          rc[ri]++;
          hist[ri].set(r.area, (hist[ri].get(r.area) || 0) + 1);
          if (r.area > 1) { tot.tiled[ri] += r.area - 1; if (isFlatTex(r.ti)) tot.tiledFlat[ri] += r.area - 1; }
        }
      }
    });
  });
  tot.mergeMs += performance.now() - t1;
  if (!sq) continue;
  samples++;
  quadCounts.push(sq);
  tot.quads += sq; tot.unit += unit; tot.odd += odd; tot.weld += weld; tot.weldOdd += weldOdd;
  RULES.forEach((_, ri) => { tot.rects[ri] += rc[ri]; });
  const soup = sq * 6;
  rows.push(`${cx},${cz}\tquads ${sq} unit ${unit} odd ${odd}\tsoup ${soup}\tweld ${weld}`
    + `\tmerged rects ${rc.join('/')}`);
}

const n = samples;
const f = (x) => Math.round(x).toLocaleString('en-US');
const pc = (a, b) => (100 * (1 - a / Math.max(1, b))).toFixed(1);
console.log(rows.join('\n'));
console.log(`\n${n} chunks with faces (of ${coords.length} asked), ${tot.ms.toFixed(0)} ms of meshing, `
  + `${tot.mergeMs.toFixed(0)} ms to find the rectangles (${(tot.mergeMs / n).toFixed(1)} ms/chunk, `
  + `three rules at once; a real mesher would run one)`);
console.log(`settings ${JSON.stringify(opts)}`);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
console.log(`quads mean ${(tot.quads / n).toFixed(0)}/chunk, median ${med(quadCounts)}   unit squares ${f(tot.unit)}   `
  + `model/partial faces that cannot join a rect ${f(tot.odd)} (${pc(tot.odd, tot.quads)} of all quads)`);
console.log(`passes: opaque ${f(perPass[0])}  cutout ${f(perPass[1])}  translucent ${f(perPass[2])}`);
const MB = (v) => (v / 1048576 / n).toFixed(2);
console.log('');
console.log(`soup    ${f(tot.quads * 6 / n)} verts/chunk  ${MB(tot.quads * 6 * 24)} MB/chunk`);
console.log(`welded  ${f(tot.weld / n)} verts/chunk     ${MB(tot.weld * 24 + tot.quads * 6 * 2)} MB/chunk`
  + `   (${pc(tot.weld, tot.quads * 6)}% fewer verts, nothing about the picture changes)`);
RULES.forEach((rule, ri) => {
  const verts = tot.weldOdd + tot.rects[ri] * 4;
  const idx = tot.rects[ri] * 6 + tot.odd * 6;
  console.log(`${rule.padEnd(7)}${f(verts / n)} verts/chunk     ${MB(verts * 24 + idx * 2)} MB/chunk`
    + `   ${f(tot.rects[ri])} rects for ${f(tot.unit)} squares: ${pc(tot.rects[ri], tot.unit)}% of unit faces folded away`
    + `   (${pc(verts, tot.quads * 6)}% fewer verts than soup)`);
});
console.log('\nrect area histogram, biggest runs per rule (area: count)');
RULES.forEach((rule, ri) => {
  const top = [...hist[ri].entries()].sort((a, b) => b[0] - a[0]).slice(0, 6)
    .map(([a, c]) => `${a}:${f(c)}`).join(' ');
  const small = [...hist[ri].entries()].sort((a, b) => a[0] - b[0]).slice(0, 4)
    .map(([a, c]) => `${a}:${f(c)}`).join(' ');
  console.log(`  ${rule.padEnd(7)}${small}  ...  ${top}`);
});
console.log('');
RULES.forEach((rule, ri) => console.log(`  ${rule.padEnd(7)}merged area beyond the first face of a rect: `
  + `${f(tot.tiled[ri])} extra sprite samples, of which ${(100 * tot.tiledFlat[ri] / Math.max(1, tot.tiled[ri])).toFixed(0)}% `
  + `land on a flat-colour sprite`));
if (has('why')) {
  console.log('\nwhy a face cannot join a rectangle:');
  for (const [k, v] of [...whyTot.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${f(v)}`);
  console.log('\nthe 30 commonest shapes that cannot join one (w x h @ sprite):');
  for (const [k, v] of [...dimsTot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k}: ${f(v)}`);
}
