// What stops a walking body, read from the chunk payloads the browser already holds.
//
// The voxels are the same truth the mesher draws, which is the whole point of keeping them in the
// browser: a wall you can see is a wall you cannot walk through, with no second collision data to go
// out of date. Kept DOM-free and three-free so a Node test can put it against real region bytes -
// see tests/web-player.test.mjs.
//
// The cell codes and their meaning live in shared/player.mjs.
import { C_UNKNOWN, C_FULL, C_PASS } from '../../shared/player.mjs';

/**
 * @param {()=>object|null} chunkAt   the held chunk for a chunk coordinate, or null (not streamed yet)
 * @param {()=>{collisionOf:(id:number)=>number}|null} assetsOf  the asset table
 * @returns {(x:number,y:number,z:number)=>number} collision code for a block coordinate
 */
export function makeCellAt(chunkAt, assetsOf) {
  return function cellAt(x, y, z) {
    const c = chunkAt(x >> 4, z >> 4);
    const assets = assetsOf();
    if (!c || !assets) return C_UNKNOWN;
    const s16 = y >> 4;
    // Below what the region stores is the bottom of the world: in this save that is deepslate and
    // bedrock, so it is a floor. Treating it as unknown is what makes a deep fall hover in mid-air.
    if (s16 < c.yMin) return C_FULL;
    if (s16 >= c.yMin + c.yCount) return C_PASS;      // above everything stored: sky
    // The section mask is sparse and a section the writer left out is a section that was all air - the
    // mesher reads it that way already. Reading it as "no data" freezes a fall inside a loaded chunk.
    const sec = c.sectionAt(y);
    if (!sec) return C_PASS;
    // State id 0 means the state table does not know this state: an unknown shape must never let a body
    // fall through it, so collisionOf() answers "full block" for it.
    return assets.collisionOf(c.stateAt(x & 15, y, z & 15));
  };
}
