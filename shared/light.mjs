// Minecraft ships two 4-bit light channels per cell. This file is the only place that turns those
// levels into a brightness, so the detail mesher, the far layer and the tests cannot drift apart.
//
// Levels arrive in the chunk payload as two codes per section (see shared/chunk-format.mjs): either
// a flat level, or LIGHT_VARIES meaning the section carries the real nibble array. Reading is done
// per cell rather than by materialising a 4096-cell grid: a grid would cost 4 KB per section for the
// majority of sections, which are flat, and the mesher only ever touches cells it draws a face on.

import { LIGHT_VARIES, LIGHT_UNKNOWN } from './chunk-format.mjs';

export const LIGHT_MAX = 15;
export { LIGHT_VARIES, LIGHT_UNKNOWN };

/**
 * Pack sky and block light into one byte: sky in the high nibble, block in the low. Handy for
 * caches and for the far layer, where one byte per column has to carry both channels.
 */
export const packLight = (sky, blk) => (((sky & 15) << 4) | (blk & 15)) & 0xff;
export const skyOf = (p) => p >> 4;
export const blkOf = (p) => p & 15;

/**
 * One number out of two channels. Minecraft combines the two channels' *brightnesses* with the sky
 * channel scaled by the time of day; scaling the level instead keeps everything 0..15 and reads the
 * same. `skyScale` of 1 is noon, 0.4 is dusk, 0 means "block light only".
 */
export function combineLight(sky, blk, skyScale = 1) {
  return Math.max(Math.round(Math.max(0, sky) * skyScale), Math.max(0, blk));
}

/**
 * Level -> brightness. Vanilla's own lightmap is roughly linear above level 7 and falls off a cliff
 * below it, which is right for a game and useless for a map viewer: a literal 0 floor turns every
 * cave into a black hole and hides the very geometry it was generated to show. `floor` is the dial
 * for that. `gamma` < 1 lifts the middle levels so a torch-lit corridor reads as light falling off
 * rather than as three brightness bands.
 */
export function lightRamp(level, floor = 0.32, gamma = 0.72) {
  const l = Math.max(0, Math.min(LIGHT_MAX, level)) / LIGHT_MAX;
  return floor + (1 - floor) * Math.pow(l, gamma);
}

/**
 * Sixteen brightness values, so a mesher can look one up per corner instead of calling pow() four
 * times per quad - on a chunk with 400k quads that difference is tens of milliseconds.
 */
export function lightLut(floor = 0.32, gamma = 0.72) {
  const t = new Float32Array(LIGHT_MAX + 1);
  for (let l = 0; l <= LIGHT_MAX; l++) t[l] = lightRamp(l, floor, gamma);
  return t;
}

/** Ramp value at a fractional level, for the averaged levels smooth lighting produces. */
export function rampAt(lut, level) {
  if (level >= LIGHT_MAX) return lut[LIGHT_MAX];
  if (level <= 0) return lut[0];
  const i = level | 0;
  return lut[i] + (lut[i + 1] - lut[i]) * (level - i);
}

/** A light code into a plain level, folding in what the payload could not know. */
const resolveCode = (code) =>
  (code === undefined || code === null ? 0
    : code >= LIGHT_UNKNOWN ? (code === LIGHT_UNKNOWN ? LIGHT_MAX : 0)   // no heightmap to reason from
      : code > LIGHT_MAX ? 0 : code);

/**
 * Vanilla nibble order: cell i lives in byte i>>1, low nibble first, and the cell index inside a
 * section is `(y << 8) | (z << 4) | x`.
 */
export const nibbleAt = (arr, i) => {
  const b = arr[i >> 1];
  return (i & 1 ? b >> 4 : b & 15) & 15;
};

/**
 * [sky, block] light at chunk-local x/z and absolute world y, or null when this chunk's payload does
 * not cover that cell. `secOf(y)` returns the payload section covering a world y - the same lookup
 * the mesher uses for voxels, so nothing new has to be kept in sync.
 */
export function lightLevels(secOf, lx, y, lz) {
  const s = secOf(y);
  if (!s) return null;
  const i = ((y & 15) << 8) | ((lz & 15) << 4) | (lx & 15);
  return [
    s.sky === LIGHT_VARIES ? nibbleAt(s.skyArr, i) : resolveCode(s.sky),
    s.blk === LIGHT_VARIES ? nibbleAt(s.blkArr, i) : resolveCode(s.blk),
  ];
}
