// Demotion keeps the *bytes* of a mesh, so the bytes have to be the whole mesh.
//
// This module is DOM-free and three-free on purpose: it only asks for the three.js *shape* of a
// geometry, which is exactly where the bug was. An index buffer is NOT an attribute - it is
// `geometry.index`, its own field. Reading `geometry.attributes.index` returns undefined, so every
// parked detail mesh parked 4 corners a quad *without* its index, and `installCached` rebuilt it as a
// triangle strip over those corners. The picture was stretched, sheared, rainbow-striped quads over
// every chunk that had been demoted and re-installed - i.e. anything the user panned away from and
// back to. It survived the 9.5a pixel A/B because a settled scene never touches the park.
//
// `parkPasses` is the only place that decision lives, so a test can hold it.

/**
 * Copy the attribute buffers of a mesh list into plain typed arrays that can outlive the GPU buffers.
 *
 * @param list  [{pass, mesh}] where mesh.geometry is three-shaped: {attributes: {position, uv, color},
 *               index: {array} | null}
 * @returns {{passes: Array, bytes: number, indexBuffers: number}}
 *          `indexBuffers` is how many passes had an index; the page compares it against the number of
 *          installs that got one, so "parked indexed, installed unindexed" is a number and not a
 *          screenshot.
 */
export function parkPasses(list) {
  const passes = [];
  let bytes = 0, indexBuffers = 0;
  for (const { pass, mesh } of list) {
    const g = mesh && mesh.geometry;
    const a = g && g.attributes;
    // geometry.index, not attributes.index. That is the whole bug, in one line.
    const gi = g && g.index;
    if (!a || !a.position || !a.position.count || !a.uv || !a.color) continue;
    // slice(): the mesher's streams are power-of-two grown, so holding a view would keep an allocation
    // up to twice the size of the chunk alive for a chunk nobody is looking at. It also detaches the
    // park from a buffer the renderer may still be about to dispose.
    passes.push({
      pass,
      position: a.position.array.slice(),
      uv: a.uv.array.slice(),
      color: a.color.array.slice(),
      index: gi ? gi.array.slice() : null,
    });
    bytes += a.position.array.byteLength + a.uv.array.byteLength + a.color.array.byteLength
      + (gi ? gi.array.byteLength : 0);
    if (gi) indexBuffers++;
  }
  return { passes, bytes, indexBuffers };
}

/**
 * The other half: does this parked record describe an indexed mesh, and does the geometry it produced
 * agree? Cheap enough to run on every install, and it is the assertion that would have failed loudly.
 */
export function indexedMatch(rec, geometry) {
  return !!rec.index === !!geometry.index;
}
