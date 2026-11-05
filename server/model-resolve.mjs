// Blockstate + model JSON -> baked quads in model space (0..16 per axis).
// Handles what this pack actually uses: variants (weighted, partial keys), multipart (with
// OR/AND/NOT), model parent chains with `#key` texture indirection, element rotation with
// rescale, per-face uv/rotation/uvlock/cullface/tintindex, and models with no elements
// (water, builtin/entity) which fall back to a full cube from the model's `particle` texture.
//
// Quad fields are terse because they are serialised:
//   p: 12 floats  (4 corners x,y,z in model space, CCW seen from outside)
//   u: 8 floats   (4 corners u,v in 0..1, already atlas-independent)
//   t: atlas texture id
//   d: face direction index (DIRS order) in *world* space, -1 if not axis aligned
//   c: cullface direction index in world space, -1 if the face must never be culled
//   s: 1 if the face takes smooth lighting/AO
//   i: 1 if the face is biome-tinted
import { DIRS, DIR_INDEX, FACE_INFO, FACE_UV_AXES, applyRot, dirForVec } from '../shared/faces.mjs';

const UV_ORDER = [[0, 0], [1, 0], [1, 1], [0, 1]];

export class ModelResolver {
  constructor(index) {
    this.index = index;
    this.modelCache = new Map();
    this.bsCache = new Map();
    this.missing = new Map();
    this.notes = new Map();
  }

  note(n) { this.notes.set(n, (this.notes.get(n) ?? 0) + 1); }
  miss(p) { this.missing.set(p, (this.missing.get(p) ?? 0) + 1); }

  blockstate(id) {
    let v = this.bsCache.get(id);
    if (v === undefined) {
      const j = this.index.readJson(id, 'blockstates');
      if (!j) this.miss(`blockstates/${id}.json`);
      this.bsCache.set(id, j ?? false);
      v = this.bsCache.get(id);
    }
    return v;
  }

  // The model applies for one concrete (name, properties) block state, or null.
  applies(id, props) {
    const bs = this.blockstate(id);
    if (!bs) return null;
    if (bs.variants) {
      const list = matchVariant(bs.variants, props);
      if (list === undefined) { this.note(`no variant match: ${id} ${propsKey(props)}`); return null; }
      return (Array.isArray(list) ? list : [list]).filter(a => a && a.model);
    }
    if (bs.multipart) {
      const out = [];
      for (const part of bs.multipart) {
        if (part.when && !cond(part.when, props)) continue;
        const a = part.apply ?? part;
        for (const one of Array.isArray(a) ? a : [a]) {
          if (one?.model) out.push(one.uvlock === undefined && part.uvlock !== undefined ? { ...one, uvlock: part.uvlock } : one);
        }
      }
      return out;
    }
    this.note(`blockstate has neither variants nor multipart: ${id}`);
    return null;
  }

  // Flatten a model's parent chain -> { elements, textures, ao, builtin, item, color } | null
  model(id, chain = new Set()) {
    if (this.modelCache.has(id)) return this.modelCache.get(id);
    if (chain.has(id)) { this.note(`model parent cycle at ${id}`); this.modelCache.set(id, null); return null; }
    chain.add(id);
    let j = this.index.readJson(id, 'models');
    if (!j) {
      this.miss(`models/${id}.json`);
      // Some mods reference models they only generate at runtime (lootr's barrels). A close sibling
      // model is a far better picture than air, and the substitution is reported.
      const alt = this.index.sibling(id, 'models');
      if (alt) {
        j = this.index.readJson(alt, 'models');
        if (j) this.note(`missing model ${id}; substituted sibling ${alt}`);
      }
    }
    if (!j) { this.modelCache.set(id, null); return null; }

    let r = { elements: null, textures: {}, ao: true, builtin: false, item: false, color: null };
    if (j.parent) {
      const pid = j.parent.includes(':') ? j.parent : qualify(j.parent);
      const p = this.model(pid, chain);
      if (p) r = { ...p, textures: { ...p.textures }, elements: p.elements };
      else if (j.parent.startsWith('builtin/')) r.builtin = true;
      if (pid.startsWith('item/') || pid.includes('builtin/generated')) r.item = true;
    }
    if (j.textures) for (const [k, v] of Object.entries(j.textures)) if (typeof v === 'string') r.textures[k] = v;
    if (Array.isArray(j.elements)) {
      const els = r.elements ? r.elements.slice() : [];
      j.elements.forEach((e, i) => {
        if (e === null) return;                       // vanilla "hole" marker
        els[i] = els[i] ? mergeElement(els[i], e) : e;
      });
      r.elements = els.filter(Boolean);
    }
    if (j.ambientocclusion !== undefined) r.ao = !!j.ambientocclusion;
    if (j.type && /item/.test(String(j.type))) r.item = true;
    if (j.parent && j.parent.startsWith('builtin/')) r.builtin = true;
    if (j.color !== undefined) { const c = parseColor(j.color); if (c != null) r.color = c; }
    this.modelCache.set(id, r);
    return r;
  }
}

// A parent reference without a namespace is the *minecraft* namespace (ResourceLocation
// semantics), not the referring mod's namespace — mods rely on this to parent off
// minecraft:block/cube_all.
const qualify = (ref) => `minecraft:${ref}`;

function mergeElement(p, c) {
  const out = { ...p, ...c };
  if (p.faces || c.faces) out.faces = { ...(p.faces ?? {}), ...(c.faces ?? {}) };
  if (p.rotation || c.rotation) out.rotation = { ...(p.rotation ?? {}), ...(c.rotation ?? {}) };
  return out;
}

function parseColor(s) {
  if (typeof s !== 'string') return null;
  const h = s.replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(h) ? parseInt(h, 16) : null;
}

const propsKey = (props) =>
  !props ? '' : Object.keys(props).sort().map(k => `${k}=${props[k]}`).join(',');

// Exact key, then empty key, then the most specific partial key this state satisfies.
function matchVariant(variants, props) {
  const key = propsKey(props);
  if (variants[key] !== undefined) return variants[key];
  if (variants[''] !== undefined) return variants[''];
  let best = null;
  for (const k of Object.keys(variants)) {
    if (!k) continue;
    const pairs = k.split(',');
    if (!pairs.every(p => { const i = p.indexOf('='); return String(props?.[p.slice(0, i)]) === p.slice(i + 1); })) continue;
    if (!best || pairs.length > best.n) best = { list: variants[k], n: pairs.length };
  }
  return best?.list;
}

function cond(c, props) {
  if (!c) return true;
  if (Array.isArray(c)) return c.some(x => cond(x, props));
  if (c.OR) return c.OR.some(x => cond(x, props));
  if (c.AND) return c.AND.every(x => cond(x, props));
  if (c.NOT) return !cond(c.NOT, props);
  if (c.property !== undefined) return String(props?.[c.property]) === String(c.value);
  for (const [k, v] of Object.entries(c)) {
    const want = String(v), have = String(props?.[k] ?? '');
    if (want.includes('|')) { if (!want.split('|').includes(have)) return false; }
    else if (have !== want) return false;
  }
  return true;
}

export function resolveTexture(textures, ref) {
  if (typeof ref !== 'string') return null;
  let cur = ref;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    if (!cur.startsWith('#')) return cur;
    const key = cur.slice(1);
    if (seen.has(key) || textures[key] === undefined) return null;
    seen.add(key);
    cur = textures[key];
  }
  return null;
}

// Bake one apply. texToIndex(texId) -> texture id (>=0) or -1 when not packed.
export function bakeApply(resolver, modelId, apply, texToIndex) {
  const m = resolver.model(modelId);
  if (!m) return null;
  const xDeg = Math.round(Number(apply.x ?? 0)) || 0;
  const yDeg = Math.round(Number(apply.y ?? 0)) || 0;
  const out = { quads: [], ao: m.ao, tint: false, kind: 'model' };

  const face = (fi, from, to, f, el) => {
    let texId = resolveTexture(m.textures, f.texture);
    if (!texId) {
      // An unresolvable #key is what Minecraft shows the missing-texture checkerboard for, so keep
      // the face and point it at the placeholder sprite rather than dropping geometry.
      resolver.note(`unresolved texture ref ${f.texture} in ${modelId}`);
      texId = 'minecraft:missingno';
    }
    const tex = texToIndex(texId);
    if (tex < 0) { resolver.miss(`textures/${texId}.png`); return; }

    const info = FACE_INFO[fi], axes = FACE_UV_AXES[fi];
    const rect = Array.isArray(f.uv) && f.uv.length === 4 && f.uv.every(Number.isFinite)
      ? f.uv.map(Number) : defaultUv(fi, from, to);

    let pts = UV_ORDER.map(([s, t]) => {
      const p = [0, 0, 0];
      p[info.axis] = info.sign > 0 ? to[info.axis] : from[info.axis];
      p[axes.uAxis] = corner(from, to, axes.uAxis, axes.uNeg, s);
      p[axes.vAxis] = corner(from, to, axes.vAxis, axes.vNeg, t);
      return p;
    });
    let uvs = UV_ORDER.map(([s, t]) => [
      rect[0] + s * (rect[2] - rect[0]),
      rect[1] + t * (rect[3] - rect[1]),
    ]);

    // Verify winding from the derived axes tables rather than trusting them blindly.
    const n0 = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]));
    if (n0[0] * info.v[0] + n0[1] * info.v[1] + n0[2] * info.v[2] < 0) { pts = pts.slice().reverse(); uvs = uvs.slice().reverse(); }

    if (el.rotation) pts = pts.map(p => rotElement(p, el.rotation));
    // apply-level x/y rotation (blockstate variants) rotates the geometry about the block centre
    const spin = xDeg || yDeg;
    if (spin) pts = pts.map(p => { const r = applyRot([p[0] - 8, p[1] - 8, p[2] - 8], xDeg, yDeg); return [r[0] + 8, r[1] + 8, r[2] + 8]; });

    const k = quarterTurns(f.rotation);
    if (k) uvs = rotateUvCorners(uvs, k);

    const p = [];
    for (const q of pts) p.push(round(q[0]), round(q[1]), round(q[2]));
    const u = [];
    for (const [uu, vv] of uvs) u.push(round(uu / 16), round(vv / 16));

    // Zero-area quads: a face on the flat side of a zero-thickness element (mod authors do declare
    // these) collapses to a line. Minecraft draws nothing for it, so neither do we - and dropping
    // it keeps the payload smaller and free of z-fighting slivers.
    {
      const e1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
      const e2 = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
      const cx = e1[1] * e2[2] - e1[2] * e2[1];
      const cy = e1[2] * e2[0] - e1[0] * e2[2];
      const cz = e1[0] * e2[1] - e1[1] * e2[0];
      if (cx * cx + cy * cy + cz * cz < 1e-6) return;
    }

    // Face normal must follow element rotation (45 degree crosses) and apply rotation.
    const modelN = el.rotation ? rotVecElement(info.v, el.rotation) : info.v;
    const worldN = applyRot(modelN, xDeg, yDeg);
    const d = dirForVec(worldN);
    // A rotated element's authored cullface no longer points at a real neighbour, so drop it.
    const cullDir = f.cullface && DIR_INDEX[f.cullface] !== undefined && !el.rotation
      ? dirForVec(applyRot(FACE_INFO[DIR_INDEX[f.cullface]].v, xDeg, yDeg)) : -1;

    out.quads.push({
      p, u, t: tex, d, c: cullDir,
      s: m.ao && el.shade !== false ? 1 : 0,
      i: f.tintindex !== undefined && f.tintindex !== null ? 1 : 0,
    });
    if (f.tintindex !== undefined && f.tintindex !== null) out.tint = true;
  };

  for (const el of m.elements ?? []) {
    const from = el.from, to = el.to;
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 3 || to.length !== 3 ||
        [...from, ...to].some(v => typeof v !== 'number')) { resolver.note(`bad element bounds in ${modelId}`); continue; }
    for (let fi = 0; fi < 6; fi++) {
      const f = (el.faces ?? {})[DIRS[fi]];
      if (f && f.texture !== undefined) face(fi, from, to, f, el);
    }
  }

  // A model with no elements at all (water, and other invisible-but-rendered liquids) still needs a
  // cube. A model whose elements all baked to nothing stays empty - it is deliberately invisible.
  if (!out.quads.length && !(m.elements ?? []).length) {
    const particle = resolveTexture(m.textures, m.textures.particle ?? '#particle');
    if (particle && texToIndex(particle) >= 0) {
      out.kind = 'cube-fallback';
      for (let fi = 0; fi < 6; fi++) face(fi, [0, 0, 0], [16, 16, 16], { texture: particle, cullface: DIRS[fi] }, {});
    } else {
      out.kind = 'empty';
    }
  }
  return out;
}

const corner = (from, to, axis, neg, s) =>
  s === 0 ? (neg ? to[axis] : from[axis]) : (neg ? from[axis] : to[axis]);

function defaultUv(fi, from, to) {
  const [x0, y0, z0, x1, y1, z1] = [...from, ...to];
  switch (DIRS[fi]) {
    case 'down': case 'up': return [x0, z0, x1, z1];
    case 'north': return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south': return [x0, 16 - y1, x1, 16 - y0];
    case 'west': return [z0, 16 - y1, z1, 16 - y0];
    case 'east': return FACE_UV_AXES[5].uNeg ? [16 - z1, 16 - y1, 16 - z0, 16 - y0] : [z0, 16 - y1, z1, 16 - y0];
  }
  return [0, 0, 16, 16];
}

const quarterTurns = (deg) => (((Math.round(Number(deg) || 0) % 360) + 360) % 360) / 90;

// Rotating a texture on a quad is a permutation of which uv pair each vertex gets.
function rotateUvCorners(uvs, k) {
  const n = uvs.length;
  return uvs.map((_, i) => uvs[(i + k) % n]);
}

// Rotation matrix for the axis, in the same handedness as the blockstate apply rotations
// (rot90x = [x,z,-y], rot90y = [-z,y,x]) so element rotation and apply rotation agree.
function rotVecElement(v, r) {
  const axis = ['x', 'y', 'z'].indexOf(String(r.axis ?? 'y'));
  const a = Number(r.angle ?? 0) * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  if (axis === 0) return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  if (axis === 1) return [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]];
  if (axis === 2) return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
  return v;
}

/**
 * Rotate a model-space point about the element's rotation origin.
 * `rescale` matches vanilla: the element is stretched by 1/cos(angle) *within the plane of
 * rotation* (the two axes perpendicular to the rotation axis) before turning, so a 45 deg
 * cross quad still spans the block face-on instead of shrinking to cos(45).
 */
export function rotElement(p, r) {
  const o = Array.isArray(r.origin) ? r.origin : [8, 8, 8];
  const axis = ['x', 'y', 'z'].indexOf(String(r.axis ?? 'y'));
  let q = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  if (r.rescale) {
    const a = Number(r.angle ?? 0) * Math.PI / 180;
    const f = 1 / Math.cos(a);
    if (Number.isFinite(f)) {
      if (axis === 0) q = [q[0], q[1] * f, q[2] * f];
      else if (axis === 1) q = [q[0] * f, q[1], q[2] * f];
      else if (axis === 2) q = [q[0] * f, q[1] * f, q[2]];
    }
  }
  q = rotVecElement(q, r);
  return [q[0] + o[0], q[1] + o[1], q[2] + o[2]];
}

const round = (v) => Math.round(v * 1000) / 1000;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
