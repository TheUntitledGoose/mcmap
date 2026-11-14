/**
 * The player model: which box is which size, and which part of the skin belongs to it.
 *
 * DOM-free and three-free on purpose: the numbers are the thing that can be wrong, and a wrong number
 * here puts a person's trousers on their shoulder. `tests/skin-layout.test.mjs` checks them, and
 * `build/dbg-skinlayout.mjs` measured the UV origins below off real downloaded skins.
 *
 * Units. Minecraft builds the player model in texture pixels, 16 of which make a block, and the sizes are
 * exactly vanilla's:
 *
 *   head  8 x 8  x 8      (wide x tall x deep)
 *   body  8 x 12 x 4
 *   arm   4 x 12 x 4      (3 wide on a "slim"/Alex model)
 *   leg   4 x 12 x 4
 *
 * Stacked: legs 12 + body 12 + head 8 = 32 px = 2.0 blocks of MODEL, standing on the feet at y=0. Note
 * what that is NOT: the hitbox a player walks through is 0.6 x 1.8 (shared/player.mjs), because the head
 * pokes above it and crouching is not model geometry. Two numbers, two questions, both correct.
 *
 * Skin UVs. A skin is a cross per box: with UV origin (ox,oy) and size (w,h,d),
 *
 *            [ top (w x d) ][ bottom (w x d) ]          row of height d
 *   [ right ][ front ][ left ][ back ]                  row of height h
 *      d x h     w x h     w x h     d x h
 *
 *   top (ox+d, oy) (w,d)      bottom (ox+d+w, oy) (w,d)
 *   right (ox, oy+d) (d,h)    front (ox+d, oy+d) (w,h)
 *   left (ox+d+w, oy+d) (w,h) back (ox+2d+w, oy+d) (d,h)
 *
 * The origins are in PARTS, and they were not remembered, they were measured: `build/dbg-skinlayout.mjs`
 * paints a per-pixel occupancy map averaged over real skins, and the crosses appear exactly where PARTS
 * says - left arm and left leg in the bottom row at x32 and x16, the head/body/right-limb overlay across
 * the middle row, the left limbs' overlay at x48 and x32 of that middle row, and the right leg's overlay
 * at x0 of the bottom row.
 *
 * UVs here are measured from the TOP-LEFT of the skin with v growing down, the same top-down convention as
 * the block atlas, so one upload rule (`flipY = false`) covers both textures.
 */

export const PX = 16;                     // texture pixels per block
export const MODEL_H_PX = 32;             // legs + body + head
export const MODEL_H = MODEL_H_PX / PX;   // 2.0 blocks, feet at y=0

/** Pixel size and UV origin of each part in the 64x64 layout; `hat` is the second (overlay) layer. */
export const PARTS = {
  head: { w: 8, h: 8, d: 8, uv: [0, 0], hat: [0, 32] },
  body: { w: 8, h: 12, d: 4, uv: [16, 16], hat: [16, 32] },
  armR: { w: 4, h: 12, d: 4, uv: [40, 16], hat: [40, 32] },
  armL: { w: 4, h: 12, d: 4, uv: [32, 48], hat: [48, 32] },
  legR: { w: 4, h: 12, d: 4, uv: [0, 16], hat: [0, 48] },
  legL: { w: 4, h: 12, d: 4, uv: [16, 48], hat: [32, 32] },
};

/** A slim ("Alex") model is the same person with 3-px-wide arms. Three of this save's six players are. */
export const SLIM_ARM_W = 3;

/** The six boxes: name, pixel box, and the UV origin of the layer it maps to. */
// How much of the world a WHOLE figure takes up: torso plus two arms, plus the overlay standing half a
// pixel proud of every face. The page needs this to draw an outline around a hovered person and to place a
// name tag over their head. The physics hitbox (0.6 x 1.8, shared/player.mjs) is a different question, and
// an outline that is narrower and shorter than the model it claims is a highlight that does not contain
// the person.
export function modelBox(slim = false, overlay = true) {
  const arm = slim ? SLIM_ARM_W : 4;
  const pad = overlay ? 2 * 0.5 : 0;                     // half a pixel on BOTH sides of every face
  const proud = overlay ? 0.5 / PX : 0;
  // The second layer is inflated on all six sides, so it stands half a pixel proud of the crown AND of the
  // soles. A box that assumed the figure spans 0..2.06 above the floor would float the outline a few
  // thousandths of a block and put a name tag above where the hat actually ends.
  return {
    w: (8 + 2 * arm + pad) / PX,
    h: (MODEL_H_PX + pad) / PX,
    top: (MODEL_H_PX + proud * PX) / PX,
    bottom: -proud,
  };
}

export function boxes({ slim = false, overlay = true, inflate = 0.5, texH = 64 } = {}) {
  const arm = slim ? SLIM_ARM_W : PARTS.armR.w;
  const place = {
    legL: [-4, 0, -2, 4, 12, 4], legR: [0, 0, -2, 4, 12, 4],
    body: [-4, 12, -2, 8, 12, 4],
    armL: [-4 - arm, 12, -2, arm, 12, 4], armR: [4, 12, -2, arm, 12, 4],
    head: [-4, 24, -4, 8, 8, 8],
  };
  const out = [];
  for (const part of Object.keys(place)) {
    const [x, y, z, w, h, d] = place[part];
    out.push({ part, hat: false, x0: x, y0: y, z0: z, x1: x + w, y1: y + h, z1: z + d,
      w, h, d, uv: uvOf(part, false, texH), uvw: w, uvh: h, uvd: d });
    if (overlay) {
      // The hat/jacket/sleeve/trousers layer, drawn `inflate` px bigger than the box under it - which is
      // how Minecraft keeps the two layers from fighting for the same pixel. Note what does NOT grow: the
      // texture rectangle stays the size of the box UNDER it. Growing that too would read texels past the
      // part's own cross (the right leg's overlay row runs to the bottom edge of the skin), which is what
      // the first version of this did - v reached 1.03 on a 64 px skin.
      out.push({ part, hat: true,
        x0: x - inflate, y0: y - inflate, z0: z - inflate,
        x1: x + w + inflate, y1: y + h + inflate, z1: z + d + inflate,
        w: w + 2 * inflate, h: h + 2 * inflate, d: d + 2 * inflate,
        uv: uvOf(part, true, texH), uvw: w, uvh: h, uvd: d });
    }
  }
  return out;
}

/** UV origin of one part's base or overlay layer, with the 64x32 fallbacks applied. */
export function uvOf(part, hat = false, texH = 64) {
  const p = PARTS[part];
  if (texH >= 64) return hat ? p.hat : p.uv;
  // A 64x32 skin has no second layer at all - the overlay rows are below the bottom of the file - and no
  // left arm or leg. Both fall back, in that order: the left limbs first become the right limb's pixels,
  // and then every overlay becomes the SAME rectangle as the layer under it (which is why an old skin's
  // hat looks like a slightly bigger copy of the head instead of a strip of nothing).
  const one = part === 'armL' ? PARTS.armR : part === 'legL' ? PARTS.legR : p;
  return one.uv;
}

/** The six face rectangles of a part, in texture pixels: `face -> [u, v, width, height]`. */
export function partFaces(part, { hat = false, slim = false, texH = 64 } = {}) {
  const [ox, oy] = uvOf(part, hat, texH);
  const arm = slim && (part === 'armL' || part === 'armR');
  return faceRects(ox, oy, arm ? SLIM_ARM_W : PARTS[part].w, PARTS[part].h, PARTS[part].d);
}

export function faceRects(ox, oy, w, h, d) {
  return {
    top: [ox + d, oy, w, d],
    bottom: [ox + d + w, oy, w, d],
    right: [ox, oy + d, d, h],
    front: [ox + d, oy + d, w, h],
    left: [ox + d + w, oy + d, w, h],
    back: [ox + 2 * d + w, oy + d, d, h],
  };
}

/**
 * One face: its outward normal, and the two directions its texture runs in.
 *
 * The rule, said once: looking at a face FROM OUTSIDE the box, u runs left to right and v runs top to
 * bottom of that face's rectangle. That is the whole reason a face texture looks like a face instead of a
 * mirrored copy of one - and a box size table with wrong corners renders a perfectly sized stranger.
 *
 * All six are chosen so cross(u, v) = -normal, so the corner order (0,0), (0,1), (1,1), (1,0) winds every
 * quad counter-clockwise as seen from outside, which is what a FrontSide material and a raycast agree on.
 * `tests/skin-layout.test.mjs` recomputes each triangle's normal and requires it to equal `n`.
 */
export const FACES = {
  front: { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  back: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
  right: { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
  left: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
  top: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  bottom: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
};

/**
 * The corner of box `b` at `a` steps along the face's u and `s` steps along its v (each 0 or 1).
 *
 * Its own exported function because it is the one place a face can be gotten wrong, and the test checks
 * all 24 corners of all 6 faces against the box's own corners.
 */
export function cornerPos(b, face, a, s) {
  const { n, u, v } = face;
  const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    // Whichever of u, v owns this axis chooses the end; the axis NEITHER owns is the normal's, and the
    // whole face sits at the far end of that one.
    const d = u[i] !== 0 ? (a ? u[i] : -u[i])
      : v[i] !== 0 ? (s ? v[i] : -v[i])
        : n[i];
    out[i] = d > 0 ? hi[i] : lo[i];
  }
  return out;
}

/**
 * Triangle soup for one body, in BLOCK units, feet at y=0, centred on x/z, chest facing +z.
 *
 * `{pos, uv, verts, tris}`: positions and top-down UVs, no colour - a skinned body takes its colour from
 * the skin, and the tinted fallback for a player with no skin is a different material over the same
 * geometry, not different geometry.
 *
 * Deliberately NOT indexed, and that is a draw-call decision rather than laziness: the people layer already
 * splits itself into one draw group per body so each one can pick its own depth policy, and the page's
 * draw range, its group spans and its ray-to-body lookup are all counted in VERTICES. An index buffer
 * would make all three of those count indices instead, for a saving of nothing at 216 corners a body.
 * (The chunk mesher did that experiment: `build/mk_index_spec.cjs`, `tests/web-index.test.mjs`.)
 */
export function bodyMesh({ slim = false, overlay = true, inflate = 0.5, texW = 64, texH = 64, column = 0 } = {}) {
  const pos = [], uvs = [];
  for (const b of boxes({ slim, overlay, inflate, texH })) {
    // uvw/uvh/uvd, not w/h/d: an inflated overlay box still reads its part's own rectangle
    const rects = faceRects(b.uv[0], b.uv[1], b.uvw, b.uvh, b.uvd);
    for (const name of Object.keys(FACES)) {
      // `column` places this person inside a shared strip of skins: one texture, one material and one
      // draw call for every body on screen, which is what keeps the two depth policies at two materials
      // instead of one per person.
      const [u0, v0, fw, fh] = rects[name];
      const u = u0 + column * 64, v = v0;
      const f = FACES[name];
      const corner = (a, s) => cornerPos(b, f, a, s);
      const uvAt = (a, s) => [(u + (a ? fw : 0)) / texW, (v + (s ? fh : 0)) / texH];
      const emit = (a, s) => {
        const P = corner(a, s);
        pos.push(P[0] / PX, P[1] / PX, P[2] / PX);
        uvs.push(...uvAt(a, s));
      };
      // (0,0),(0,1),(1,1) then (0,0),(1,1),(1,0): counter-clockwise from outside, see FACES
      emit(0, 0); emit(0, 1); emit(1, 1);
      emit(0, 0); emit(1, 1); emit(1, 0);
    }
  }
  return { pos, uv: uvs, verts: pos.length / 3, tris: pos.length / 9 };
}

/**
 * Match the players the page has (timeline player indices, in the ledger's own order) to the skins it was
 * given, and hand each match a column in the shared skin strip.
 *
 * Names, because that is what both sides have: the timeline names its players and `tools/fetch-skins.mjs`
 * records the name Mojang answers for the UUID in `world/playerdata`. The match ignores case and trailing
 * whitespace because a name written into a log in 2021 and a name Mojang returns today are not always the
 * same casing, and a missed match only costs a tinted stand-in, never a wrong skin on the wrong person:
 * the same name can only ever be one column.
 *
 * Returns `{slots, byIndex, columns, unmatched}`: `byIndex[i]` is `{column, slim, name}` for the timeline
 * player index i, or null. `unmatched` lists the names that have a skin but nobody in this dimension, and
 * the names that are standing there with nothing to wear - both are worth printing, because "the skins
 * are not showing" is otherwise a guess.
 */
export function assignSkins(names, skins) {
  const byName = new Map();
  (skins || []).forEach((s, i) => {
    // A skin may arrive as a manifest entry (it has a texture PATH) or as a strip cell the server already
    // composed (it has a COLUMN and no path: the pixels live in a shared PNG). Refusing the second kind is
    // how every body ended up reported as skinless while wearing the first player's face.
    if (!s) return;
    const column = s.column ?? i;
    if (!s.texture && !s.file && typeof column !== 'number') return;
    byName.set(norm(s.name), { ...s, column });
  });
  const byIndex = [];
  const assigned = new Map();
  const worn = new Set();
  (names || []).forEach((nm, i) => {
    if (!nm) return;
    const s = byName.get(norm(nm));
    if (!s) return;
    byIndex[i] = { column: s.column, slim: !!s.slim, name: s.name };
    assigned.set(s.column, { column: s.column, name: s.name, slim: !!s.slim,
      hash: s.hash ?? null, texture: s.texture ?? s.file ?? null,
      w: s.w ?? s.size?.[0] ?? 64, h: s.h ?? s.size?.[1] ?? 64 });
    worn.add(s.name);
  });
  return {
    // the columns actually worn by someone on screen, not every column in the strip
    columns: [...assigned.values()].sort((a, b) => a.column - b.column),
    list: [...assigned.values()].sort((a, b) => a.column - b.column),
    byIndex,
    unmatched: {
      skinsWithNobody: [...byName.keys()].filter((n) => !worn.has(byName.get(n).name)),
      peopleWithNoSkin: (names || []).filter((nm, i) => nm && !byIndex[i]).map((nm) => nm),
    },
  };
}
const norm = (n) => String(n || '').trim().toLowerCase();
