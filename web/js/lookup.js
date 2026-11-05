// The one place that turns chunk-local coordinates into an atlas state index. Both the main thread
// (pick/ray probes, ChunkStore) and the mesh workers go through here, so a worker can never decide
// a face is hidden while the page still thinks it is visible.
//
// Coordinates follow the mesher's convention: `lx`/`lz` are chunk-local but may step one cell
// outside 0..15 at a border, and `ly` is an absolute world y.

import { combineLight, lightLevels } from '../../shared/light.mjs';

/**
 * Global state id at (lx, ly, lz) inside chunk `ch`, or 0 for air/absent.
 *
 * `secOf(y)` returns the section covering a block y. A decoded payload chunk carries its own
 * `sectionAt`; a chunk handed to a worker is plain data, so the worker indexes sections itself.
 * Keeping that difference outside this function is the point: the voxel arithmetic below — the
 * `single` shortcut, the (y,z,x) section layout, the palette indirection — is shared.
 */
export function voxelId(ch, secOf, lx, ly, lz) {
  const s = secOf(ly);
  if (!s) return 0;
  const slot = s.single ? s.single - 1 : s.vox[((ly & 15) << 8) | ((lz & 15) << 4) | (lx & 15)];
  return ch.palette[slot] ?? 0;
}

/** Payload ids are atlas index + 1; 0 means unknown and has no state to look at. */
export const idToState = (id, maxStates) =>
  (id === 0 || id > maxStates ? -1 : id - 1);

/**
 * Atlas state index for a coordinate that may fall in a neighbouring chunk, or -1 when nothing is
 * loaded there. `get(cx, cz)` returns a chunk plus its section index.
 */
export function stateIndexAt(get, cx, cz, lx, ly, lz, maxStates) {
  const e = get(cx + (lx >> 4), cz + (lz >> 4));
  if (!e) return -1;
  return idToState(voxelId(e.ch, e.secOf, lx, ly, lz), maxStates);
}

/** Section lookup for a plain (clone-friendly) chunk: payload sections are sparse by y. */
export function sectionIndex(ch) {
  const byY = new Map(ch.sections.map((s) => [s.y, s]));
  return (y) => byY.get(y >> 4);
}

/**
 * Combined sky+block light level (0..15) at a coordinate that may sit in a neighbouring chunk, or
 * -1 when nothing is loaded there or the payload carries no light. Same getter shape as
 * `stateIndexAt` on purpose: the mesher's occlusion and light probes must resolve coordinates the
 * same way, or a face is lit by one chunk and hidden by another.
 */
export function lightLevelAt(get, cx, cz, lx, ly, lz, skyScale = 1) {
  const e = get(cx + (lx >> 4), cz + (lz >> 4));
  if (!e) return -1;
  const lv = lightLevels(e.secOf, lx, ly, lz);
  return lv ? combineLight(lv[0], lv[1], skyScale) : -1;
}

/**
 * Skylight alone (0..15) at a coordinate that may sit in a neighbouring chunk, or -1 when nobody
 * holds it. `lightLevelAt` folds block light in, so an unlit passage and a lava-filled cavern answer
 * the same 0 there; only this one answers 0 for the cavern and 15 for the passage. That is the
 * difference between "no light in here" and "nothing above here but rock", which is what the buried
 * face test needs.
 */
export function skyLevelAt(get, cx, cz, lx, ly, lz) {
  const e = get(cx + (lx >> 4), cz + (lz >> 4));
  if (!e) return -1;
  const lv = lightLevels(e.secOf, lx, ly, lz);
  return lv ? lv[0] : -1;
}
