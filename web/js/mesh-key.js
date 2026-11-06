// 9.6: what a chunk's triangles actually depend on - DOM-free, three-free, so a test can hold it.//
// A chunk gets meshed when the store marks it dirty, and the store marks a chunk *and its four
// neighbours* every time anything arrives or leaves. In a streaming wave that is up to five mesh jobs
// per chunk (tens of milliseconds each) producing identical triangles, and a parked camera still paid
// for 33 of them in five idle seconds. So the mesh carries a key made of the only things that can
// change it, and a dirty mark whose key already matches installs nothing.
//
// The rule that makes this safe: an unknown neighbour is never the same as an empty one. A neighbour
// that is not held has no stamp, so the moment it is known the key changes - the wall against it is
// built from real voxels rather than from a guess.

/**
 * @param {(cx,cz) => object|null} getChunk   the store's held payload, or null when unknown
 * @param {(cx,cz) => boolean} [isMissing]    true for a hole the server confirmed (never asked again)
 */
export function meshKeyTool(getChunk, isMissing) {
  /**
   * A stamp for "these exact voxels". A payload held by a store is immutable, but identity alone is
   * the wrong question: panning away and back refetches ground nobody edited, and an identity stamp
   * calls that a new chunk, so every parked triangle set and every key on the border is thrown away.
   * `digest` (a fingerprint of the frame bytes) is the answer that survives the round trip; identity
   * remains only for payloads that have none (synthetic payloads in tests).
   */
  const stamps = new WeakMap();
  let last = 0;
  const stampOf = (c) => {
    if (!c) return 0;
    if (c.digest) return `d${c.digest}`;
    let s = stamps.get(c);
    if (!s) { s = ++last; stamps.set(c, s); }
    return `i${s}`;
  };

  /**
   * @param {number} cx,cz  the chunk
   * @param {string} settings  a signature of everything the mesher is configured with (AO, light, cave
   *   culling, dimension, atlas) - part of the key so a settings change invalidates every mesh
   * @param {string} covered  what the far skin owns around this chunk (the mesher skips walls there)
   */
  const key = (cx, cz, settings, covered = '') => {
    let s = `${settings}|${stampOf(getChunk(cx, cz))}|${covered}`;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        s += `|${stampOf(getChunk(cx + dx, cz + dz))}`;
      }
    }
    return s;
  };

  /**
   * Are all eight neighbours accounted for - held, or a confirmed hole? While one is still in flight,
   * the mesh built now has a wall against the unknown in it and the arrival forces a second mesh of the
   * same chunk shortly after. Waiting out a fetch that is already running is free, and the first mesh
   * comes out right.
   */
  const settled = (cx, cz) => {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        if (!getChunk(cx + dx, cz + dz) && !(isMissing && isMissing(cx + dx, cz + dz))) return false;
      }
    }
    return true;
  };

  return { key, settled, stampOf, held: () => last };
}
