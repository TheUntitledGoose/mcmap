/**
 * The blending arithmetic the GPU performs on translucent passes, kept in one place so a probe can
 * predict a water pixel instead of describing it afterwards.
 *
 * Values are 0..255 sRGB bytes, because three.js blends in the framebuffer after the shader has
 * written sRGB - not in linear light. Getting that detail wrong is the difference between a predicted
 * lake bed and a plausible-looking guess.
 */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How much of a fragment one quad actually paints.
 *
 * The material's opacity and the sprite's own alpha multiply: a water face with material opacity 0.72
 * and mean sprite alpha 0.706 lets just under half the backdrop through. Treating the material value
 * as the whole story is why a predicted water pixel comes out too saturated.
 *
 * `texAlpha` is 1 for opaque and cutout sprites: a cutout quad either has a texel there or it does not,
 * and the quad being hit at all means it had one.
 */
export const layerAlpha = (matOpacity, texAlpha) => clamp01(matOpacity ?? 1) * clamp01(texAlpha ?? 1);

/** Source-over one layer onto `bg` (an [r,g,b] byte triple). */
export const over = (bg, rgb, a) => {
  const k = clamp01(a);
  return [0, 1, 2].map((i) => rgb[i] * k + bg[i] * (1 - k));
};

/**
 * Composite a front-to-back layer stack over `bg`, stopping as soon as the stack is opaque.
 * Returns `{ rgb, used, coverage }`, where `used` is how many layers were consumed - a probe that
 * predicted a pixel from one layer when the ray actually hit four is announcing a mis-attribution.
 */
export const stackOver = (bg, layers) => {
  let out = [bg[0], bg[1], bg[2]];
  let coverage = 0;
  let used = 0;
  for (const l of layers) {
    if (coverage > 0.999) break;
    out = over(out, l.rgb, l.a);
    coverage = 1 - (1 - coverage) * (1 - clamp01(l.a));
    used++;
  }
  return { rgb: out.map((v) => Math.round(v)), used, coverage };
};

/** Distance used by every colour probe in this repo: worst channel error, in byte space. */
export const dmax = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
