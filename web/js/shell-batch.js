// Carrying a shell patch to a worker.
//
// A far patch cut is 20-25 ms of mesher work, and it runs on the render thread: one of them blows a
// frame, and a pan asks for sixty of them. The mesher itself is DOM-free and already runs in the mesh
// workers for chunks, so the only thing in the way is the data: a cut reads the shell frames of its
// own patch plus one chunk of border, which is what `PATCH_REACH` measures rather than guesses.
//
// The frames travel as the bytes they were parsed from - one ArrayBuffer plus an offset table, which
// postMessage moves rather than copies - and the worker runs the same `openShellFrame` parser the page
// does. That is deliberate: a second parser here would be a second opinion about the wire format, and
// two opinions about a wire format is how a border seam becomes a month of debugging.
import { openShellFrame } from './payload.js';

/**
 * How far outside the patch rect `meshShellPatch` reaches. Measured, not assumed: a spy getter over real
 * packs (tools/dbg-patchreach.mjs) saw the mesher ask for exactly one chunk of border at every cell
 * size from 1 to 16. Packed too tightly and the worker cuts holes at patch borders; packed too loose
 * and the message grows for nothing. tests/web-shellbatch.test.mjs fails if the mesher ever asks
 * outside this, so an increase here is forced to be a deliberate one.
 */
export const PATCH_REACH = 1;

/**
 * Copy the shell frames of a rect into one buffer.
 *
 * @param shellAt (cx,cz) => frame|null - the page's shell lookup
 * @returns {{x0,z0,w,h,offs:Uint32Array,bytes:ArrayBuffer}} `offs` is byte offsets per rect cell,
 *          so `offs[k+1] === offs[k]` means that chunk has no frame (a hole, or not fetched yet).
 */
export function packPatchFrames(shellAt, x0, z0, w, h) {
  const n = w * h;
  const found = new Array(n);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const sh = shellAt(x0 + (k % w), z0 + ((k / w) | 0)) ?? null;
    found[k] = sh;
    if (sh && sh.buf) total += sh.len;
  }
  const bytes = new Uint8Array(total);       // zero-filled: an absent frame simply occupies nothing
  const offs = new Uint32Array(n + 1);
  let p = 0;
  for (let k = 0; k < n; k++) {
    offs[k] = p;
    const sh = found[k];
    if (sh && sh.buf) {
      bytes.set(new Uint8Array(sh.buf, sh.p, sh.len), p);
      p += sh.len;
    }
  }
  offs[n] = p;
  return { x0, z0, w, h, offs, bytes: bytes.buffer };
}

/**
 * A `get(cx, cz)` over a packed rect, parsing each frame on first touch. Frames outside the rect read
 * `null` and are counted in `stats.outside`, because a null where the page would have found a frame is
 * a hole in the view and must never be silent.
 */
export function patchFrameGetter(pack) {
  const { offs, x0, z0, w, h } = pack;
  const bytes = pack.bytes;
  const cache = new Map();
  const get = (cx, cz) => {
    get.asked++;
    const i = cx - x0, j = cz - z0;
    if (i < 0 || j < 0 || i >= w || j >= h) { get.outside++; return null; }
    const k = j * w + i;
    if (offs[k] === offs[k + 1]) return null;
    let sh = cache.get(k);
    if (sh === undefined) {
      try { sh = openShellFrame(bytes, offs[k], offs[k + 1] - offs[k]); }
      catch { sh = null; }                            // a frame the parser refuses reads as a hole
      cache.set(k, sh);
    }
    if (sh) get.found++;
    return sh;
  };
  get.asked = 0; get.found = 0; get.outside = 0;
  return get;
}

/** The per-chunk numbers the page decides and the worker cannot: cell size, and who owns the ground. */
export function packPatchPolicy(cellFor, skip, x0, z0, w, h) {
  const n = w * h;
  const cells = new Uint8Array(n), skips = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const cx = x0 + (k % w), cz = z0 + ((k / w) | 0);
    cells[k] = Math.max(1, Math.min(255, cellFor ? (+cellFor(cx, cz) || 1) : 1));
    skips[k] = skip && skip(cx, cz) ? 1 : 0;
  }
  return { cells, skips };
}

/** The worker side of `packPatchPolicy`: the two closures the mesher asked for. */
export function patchPolicy(pack, cells, skips) {
  const { x0, z0, w, h } = pack;
  const at = (cx, cz) => {
    const i = cx - x0, j = cz - z0;
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  return {
    cellFor: (cx, cz) => { const k = at(cx, cz); return k < 0 ? 1 : cells[k]; },
    skip: (cx, cz) => { const k = at(cx, cz); return k >= 0 && skips[k] === 1; },
  };
}
