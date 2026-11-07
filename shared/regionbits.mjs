// Which region files a save actually has, as a bit per region cell.
//
// A save's bounding box is not its coverage: DarkRPG spans 1,394 region cells and has 437 files.
// Anything that walks the box - the browser requesting a tile, the server answering a block - pays
// for the ~950 cells that were never written unless it can ask this question first.
//
// Pure: no fs, no DOM, no three. The server packs it from a directory listing; the browser gets it
// as JSON over /regions and answers the same question locally.
//
// Rule for every consumer: absence here is an optimisation, not truth. A cell reads as empty only
// while the listing behind it is fresh; if the answer is unknown, say "ground" and let the request
// happen.

/** Region cells (from file names) -> bit grid over their own bounding box. Empty in, null out. */
export function packCells(cells) {
  if (!cells?.length) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, c.rx); x1 = Math.max(x1, c.rx);
    z0 = Math.min(z0, c.rz); z1 = Math.max(z1, c.rz);
  }
  const w = x1 - x0 + 1, h = z1 - z0 + 1;
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  for (const c of cells) {
    const i = (c.rz - z0) * w + (c.rx - x0);
    bits[i >> 3] |= 1 << (i & 7);
  }
  return { x0, z0, w, h, bits };
}

const at = (g, rx, rz) => {
  const dx = rx - g.x0, dz = rz - g.z0;
  if (dx < 0 || dz < 0 || dx >= g.w || dz >= g.h) return 0;
  const i = dz * g.w + dx;
  return (g.bits[i >> 3] >> (i & 7)) & 1;
};

/** Reader over a packed grid. Out-of-grid is empty - the grid is the save's own bounding box. */
export function makeReader(grid) {
  if (!grid) return { empty: true, has: () => false, hasAny: () => false, count: () => 0 };
  const { x0, z0, w, h } = grid;
  let n = 0;
  for (let rz = z0; rz < z0 + h; rz++) for (let rx = x0; rx < x0 + w; rx++) n += at(grid, rx, rz);
  return {
    empty: false, x0, z0, w, h, count: n,
    has: (rx, rz) => !!at(grid, rx, rz),
    /** Any region cell overlapping the chunk rectangle [cx0, cx0+cw-1] x [cz0, cz0+ch-1]? */
    hasAny(cx0, cz0, cw, ch) {
      const r0 = Math.max(Math.floor(cx0 / 32), x0), r1 = Math.min(Math.floor((cx0 + cw - 1) / 32), x0 + w - 1);
      const s0 = Math.max(Math.floor(cz0 / 32), z0), s1 = Math.min(Math.floor((cz0 + ch - 1) / 32), z0 + h - 1);
      for (let rz = s0; rz <= s1; rz++) for (let rx = r0; rx <= r1; rx++) if (at(grid, rx, rz)) return true;
      return false;
    },
  };
}

/**
 * JSON wire form. `bits` is a plain array of byte values: 1,394 cells is 175 bytes either way, and
 * a number array needs no codec on either side, which is worth more than the ~350 bytes it costs.
 */
export function toWire(grid) {
  if (!grid) return null;
  return { x0: grid.x0, z0: grid.z0, w: grid.w, h: grid.h, bits: Array.from(grid.bits) };
}

export function fromWire(wire) {
  if (!wire) return null;
  return { x0: wire.x0, z0: wire.z0, w: wire.w, h: wire.h, bits: Uint8Array.from(wire.bits) };
}
