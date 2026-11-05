// Texture atlas packer: shelf-packs decoded RGBA images into a power-of-two atlas with a 1px
// edge-clamped gutter around every cell (gutter keeps bilinear/mip sampling from bleeding
// neighbouring textures into each other).
export function packTextures(entries, { maxSide = 64, minSize = 256 } = {}) {
  const items = entries.map((e, i) => {
    const scale = Math.min(1, maxSide / Math.max(e.w, e.h));
    const w = Math.max(1, Math.floor(e.w * scale));
    const h = Math.max(1, Math.floor(e.h * scale));
    return { id: e.id, i, src: e, w, h, side: Math.max(w, h) };
  }).sort((a, b) => b.h - a.h || b.w - a.w);

  for (let size = minSize; ; size *= 2) {
    const cells = [];
    let x = 0, y = 0, rowH = 0, used = 0;
    for (const it of items) {
      const cw = it.w + 2, ch = it.h + 2;
      if (cw > size) { cells.length = 0; break; }            // need a bigger atlas
      if (x + cw > size) { x = 0; y += rowH; rowH = 0; }
      if (y + ch > size) { cells.length = 0; break; }
      cells.push({ id: it.id, src: it.src, x: x + 1, y: y + 1, w: it.w, h: it.h });
      x += cw; rowH = Math.max(rowH, ch);
      used = Math.max(used, y + ch);
    }
    if (cells.length === items.length) {
      const rgba = new Uint8Array(size * size * 4);
      for (const c of cells) blit(rgba, size, c);
      return { size, cells, rgba };
    }
    if (size >= 8192) throw new Error('atlas too large');
  }
}

function blit(atlas, size, c) {
  const { x, y, w, h, src } = c;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  for (let py = -1; py <= h; py++) {
    const sy = (clamp(py, 0, h - 1) * src.h / h) | 0;
    for (let px = -1; px <= w; px++) {
      const sx = (clamp(px, 0, w - 1) * src.w / w) | 0;
      const s = (sy * src.w + sx) * 4;
      const o = ((y + py) * size + (x + px)) * 4;
      atlas[o] = src.rgba[s]; atlas[o + 1] = src.rgba[s + 1];
      atlas[o + 2] = src.rgba[s + 2]; atlas[o + 3] = src.rgba[s + 3];
    }
  }
}

// Sample stats used for render-kind classification.
export function textureStats(img) {
  let minA = 255, semi = 0, transparent = 0, opaque = 0;
  for (let i = 3; i < img.rgba.length; i += 4) {
    const a = img.rgba[i];
    if (a < minA) minA = a;
    if (a === 0) transparent++;
    else if (a === 255) opaque++;
    else semi++;
  }
  return { minA, semi, transparent, opaque };
}
